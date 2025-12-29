import { join, dirname, basename } from "@std/path";
import { z } from "zod";
import { calculateFileHash, calculateHashFromContent } from "./hash.ts";
import { getRepoInfoFromPath, type RepoInfo } from "./git.ts";

// Settings file path
const CONFIG_DIR = join(Deno.env.get("HOME") ?? "", ".config", "vibe");
const USER_SETTINGS_FILE = join(CONFIG_DIR, "settings.json");

// Current schema version
const CURRENT_SCHEMA_VERSION = 3;

// Maximum number of hashes to keep per file (FIFO)
// 100 hashes × 64 bytes (SHA-256 hex) = ~6.4KB per file
// This limit prevents unbounded growth while supporting extensive branch switching
// and configuration changes. In practice, most projects will use far fewer hashes.
const MAX_HASH_HISTORY = 100;

// ===== Schema Definitions =====

// v1 schema
const SettingsSchemaV1 = z.object({
  version: z.literal(1),
  permissions: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
});

// Legacy schema (no version field)
const LegacySettingsSchema = z.object({
  permissions: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
});

// v2 schema
const SettingsSchemaV2 = z.object({
  version: z.literal(2),
  skipHashCheck: z.boolean().optional(),
  permissions: z.object({
    allow: z.array(z.object({
      path: z.string(),
      hashes: z.array(z.string()),
      skipHashCheck: z.boolean().optional(),
    })),
    deny: z.array(z.string()),
  }),
});

// v3 schema - repository-based trust
const SettingsSchemaV3 = z.object({
  version: z.literal(3),
  skipHashCheck: z.boolean().optional(),
  permissions: z.object({
    allow: z.array(z.object({
      repoId: z.object({
        remoteUrl: z.string().optional(),
        repoRoot: z.string().optional(),
      }),
      relativePath: z.string(),
      hashes: z.array(z.string()),
      skipHashCheck: z.boolean().optional(),
    })),
    deny: z.array(z.string()),
  }),
});

// Current schema in use
const CurrentSettingsSchema = SettingsSchemaV3;
export type VibeSettings = z.infer<typeof CurrentSettingsSchema>;

// ===== Migration =====

type MigrationFn = (data: unknown) => Promise<unknown>;

const migrations: Record<number, MigrationFn> = {
  // Migration from legacy (no version) to v1
  0: (data: unknown) => {
    const legacy = LegacySettingsSchema.safeParse(data);
    if (legacy.success) {
      return Promise.resolve({
        version: 1,
        permissions: legacy.data.permissions,
      });
    }
    // Return as-is if parsing fails
    return Promise.resolve(data);
  },

  // Migration from v1 to v2 (add hashes)
  1: async (data: unknown) => {
    const v1 = SettingsSchemaV1.safeParse(data);
    if (!v1.success) {
      return data;
    }

    const allowWithHashes = await Promise.all(
      v1.data.permissions.allow.map(async (path) => {
        try {
          const hash = await calculateFileHash(path);
          return { path, hashes: [hash] };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.warn(
            `Warning: Cannot calculate hash for ${path}: ${errorMessage}\n` +
              `The path will be kept with hash checking disabled (skipHashCheck: true)`,
          );
          // Keep the path but disable hash checking instead of removing it
          return { path, hashes: [], skipHashCheck: true };
        }
      }),
    );

    return {
      version: 2,
      skipHashCheck: false,
      permissions: {
        allow: allowWithHashes,
        deny: v1.data.permissions.deny,
      },
    };
  },

  // Migration from v2 to v3 (repository-based trust)
  2: async (data: unknown) => {
    const v2 = SettingsSchemaV2.safeParse(data);
    if (!v2.success) {
      return data;
    }

    const migrationWarnings: string[] = [];
    const allowWithRepoInfo = await Promise.all(
      v2.data.permissions.allow.map(async (entry) => {
        try {
          // Get repository information from the absolute path
          const repoInfo = await getRepoInfoFromPath(entry.path);

          if (repoInfo) {
            // Successfully converted to repository-based entry
            return {
              repoId: {
                remoteUrl: repoInfo.remoteUrl,
                repoRoot: repoInfo.repoRoot,
              },
              relativePath: repoInfo.relativePath,
              hashes: entry.hashes,
              skipHashCheck: entry.skipHashCheck,
            };
          } else {
            // Not in a git repository - use fallback
            migrationWarnings.push(
              `Cannot determine repository for ${entry.path}. ` +
                `Using directory as fallback.`,
            );
            return {
              repoId: {
                repoRoot: dirname(entry.path),
              },
              relativePath: basename(entry.path),
              hashes: entry.hashes,
              skipHashCheck: entry.skipHashCheck,
            };
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          migrationWarnings.push(
            `Migration failed for ${entry.path}: ${errorMessage}. ` +
              `Entry will be preserved with hash checking disabled.`,
          );
          // Preserve entry with safe fallback
          return {
            repoId: {
              repoRoot: dirname(entry.path),
            },
            relativePath: basename(entry.path),
            hashes: entry.hashes || [],
            skipHashCheck: true,
          };
        }
      }),
    );

    // Display warnings after migration
    if (migrationWarnings.length > 0) {
      console.warn("\n⚠️  Migration Warnings:");
      migrationWarnings.forEach((w) => console.warn(`  - ${w}`));
      console.warn(
        "\nRun 'vibe verify' to check trust status and 'vibe trust' to update entries.\n",
      );
    }

    return {
      version: 3,
      skipHashCheck: v2.data.skipHashCheck,
      permissions: {
        allow: allowWithRepoInfo,
        deny: v2.data.permissions.deny,
      },
    };
  },
};

function getSchemaVersion(data: unknown): number {
  const hasVersion = typeof data === "object" && data !== null && "version" in data;
  if (hasVersion) {
    const version = (data as { version: unknown }).version;
    const isValidVersion = typeof version === "number";
    if (isValidVersion) {
      return version;
    }
  }
  return 0; // Legacy (no version)
}

async function migrateSettings(data: unknown): Promise<unknown> {
  let currentData = data;
  let version = getSchemaVersion(currentData);

  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = migrations[version];
    const hasMigration = migration !== undefined;
    if (!hasMigration) {
      throw new Error(`Migration from version ${version} is not defined`);
    }
    currentData = await migration(currentData);
    version = getSchemaVersion(currentData);
  }

  return currentData;
}

// ===== Default Settings =====

function createDefaultSettings(): VibeSettings {
  return {
    version: CURRENT_SCHEMA_VERSION,
    skipHashCheck: false,
    permissions: {
      allow: [],
      deny: [],
    },
  };
}

// ===== File Operations =====

async function ensureConfigDir(): Promise<void> {
  try {
    await Deno.mkdir(CONFIG_DIR, { recursive: true });
  } catch (error) {
    const isAlreadyExists = error instanceof Deno.errors.AlreadyExists;
    if (!isAlreadyExists) {
      throw error;
    }
  }
}

export async function loadUserSettings(): Promise<VibeSettings> {
  try {
    const content = await Deno.readTextFile(USER_SETTINGS_FILE);
    const rawData = JSON.parse(content);

    // Execute migration (async)
    const migratedData = await migrateSettings(rawData);

    // Schema validation
    const result = CurrentSettingsSchema.safeParse(migratedData);
    if (result.success) {
      // Update file if migration was performed
      const needsMigration = getSchemaVersion(rawData) !==
        CURRENT_SCHEMA_VERSION;
      if (needsMigration) {
        await saveUserSettings(result.data);
      }
      return result.data;
    }

    // Return default settings on validation failure
    console.error(
      "Settings validation failed, using defaults:",
      result.error.message,
    );
    return createDefaultSettings();
  } catch {
    return createDefaultSettings();
  }
}

export async function saveUserSettings(settings: VibeSettings): Promise<void> {
  // Validate settings before saving
  const result = CurrentSettingsSchema.safeParse(settings);
  if (!result.success) {
    throw new Error(
      `Invalid settings schema: ${result.error.message}`,
    );
  }

  await ensureConfigDir();
  const content = JSON.stringify(settings, null, 2) + "\n";
  await Deno.writeTextFile(USER_SETTINGS_FILE, content);
}

// ===== Helper Functions =====

/**
 * Find a matching entry in the allow list based on repository information
 * @param allowList List of allowed entries
 * @param repoInfo Repository information to match
 * @returns Matching entry or undefined
 */
function findMatchingEntry(
  allowList: VibeSettings["permissions"]["allow"],
  repoInfo: RepoInfo,
): VibeSettings["permissions"]["allow"][number] | undefined {
  return allowList.find((entry) => {
    // Check relative path match
    if (entry.relativePath !== repoInfo.relativePath) {
      return false;
    }

    // Priority 1: Match by remote URL (if both have it)
    if (entry.repoId.remoteUrl && repoInfo.remoteUrl) {
      return entry.repoId.remoteUrl === repoInfo.remoteUrl;
    }

    // Priority 2: Match by repo root
    if (entry.repoId.repoRoot && repoInfo.repoRoot) {
      return entry.repoId.repoRoot === repoInfo.repoRoot;
    }

    return false;
  });
}

// ===== Public API =====

export async function addTrustedPath(path: string): Promise<void> {
  const settings = await loadUserSettings();

  // Get repository information
  const repoInfo = await getRepoInfoFromPath(path);
  if (!repoInfo) {
    throw new Error(
      `Cannot trust file outside of git repository: ${path}\n` +
        `Vibe requires configuration files to be within a git repository.`,
    );
  }

  // Calculate file hash
  const hash = await calculateFileHash(path);

  // Find existing entry in allow list
  const existingEntry = findMatchingEntry(settings.permissions.allow, repoInfo);

  if (existingEntry) {
    // Add hash to existing entry (with duplicate check and FIFO)
    const hashAlreadyExists = existingEntry.hashes.includes(hash);
    if (!hashAlreadyExists) {
      existingEntry.hashes.push(hash);
      // Apply FIFO: remove oldest hash if limit exceeded
      if (existingEntry.hashes.length > MAX_HASH_HISTORY) {
        existingEntry.hashes.shift(); // Remove first (oldest) element
      }
    }
  } else {
    // Create new entry
    settings.permissions.allow.push({
      repoId: {
        remoteUrl: repoInfo.remoteUrl,
        repoRoot: repoInfo.repoRoot,
      },
      relativePath: repoInfo.relativePath,
      hashes: [hash],
    });
  }

  await saveUserSettings(settings);
}

export async function removeTrustedPath(path: string): Promise<void> {
  const settings = await loadUserSettings();

  // Get repository information
  const repoInfo = await getRepoInfoFromPath(path);
  if (!repoInfo) {
    // Cannot determine repository, try to remove anyway if path matches
    console.warn(
      `Warning: Cannot determine repository for ${path}. ` +
        `Removal may not work correctly.`,
    );
    return;
  }

  // Find and remove matching entry
  const allowIndex = settings.permissions.allow.findIndex((entry) => {
    return entry.relativePath === repoInfo.relativePath &&
      (
        (entry.repoId.remoteUrl && repoInfo.remoteUrl &&
          entry.repoId.remoteUrl === repoInfo.remoteUrl) ||
        (entry.repoId.repoRoot && repoInfo.repoRoot &&
          entry.repoId.repoRoot === repoInfo.repoRoot)
      );
  });

  const isInAllowList = allowIndex !== -1;
  if (isInAllowList) {
    settings.permissions.allow.splice(allowIndex, 1);
  }

  await saveUserSettings(settings);
}

/**
 * Check if a file is trusted (internal use only)
 *
 * @internal This function is for internal use and testing only.
 * Do not use in production code - use `verifyTrustAndRead()` instead to prevent TOCTOU vulnerabilities.
 * This function only checks trust status without reading the file, which creates a race condition
 * between verification and file read.
 *
 * @param vibeFilePath Path to the vibe config file
 * @returns true if the file is trusted
 */
export async function isTrusted(vibeFilePath: string): Promise<boolean> {
  const settings = await loadUserSettings();

  // Get repository information from file path
  const repoInfo = await getRepoInfoFromPath(vibeFilePath);
  if (!repoInfo) {
    // Not in a git repository
    return false;
  }

  // Find matching entry in allow list
  const entry = findMatchingEntry(settings.permissions.allow, repoInfo);
  if (!entry) {
    return false;
  }

  // Determine whether to skip hash check
  // Priority: per-path setting > global setting > default (false)
  const shouldSkipHashCheck = entry.skipHashCheck ??
    settings.skipHashCheck ?? false;
  if (shouldSkipHashCheck) {
    console.warn(
      `Warning: Hash verification is disabled for ${vibeFilePath}`,
    );
    return true; // Trust unconditionally if skip is enabled
  }

  // Calculate file hash
  const fileHash = await calculateFileHash(vibeFilePath);

  // Check if hash matches any stored hash
  const hashMatches = entry.hashes.includes(fileHash);
  return hashMatches;
}

/**
 * Atomically read file and verify trust to prevent TOCTOU attacks
 * @param vibeFilePath Path to the vibe config file
 * @returns Object with trusted flag and file content if trusted
 */
export async function verifyTrustAndRead(
  vibeFilePath: string,
): Promise<{ trusted: boolean; content?: string }> {
  const settings = await loadUserSettings();

  // Get repository information from file path
  const repoInfo = await getRepoInfoFromPath(vibeFilePath);
  if (!repoInfo) {
    // Not in a git repository
    return { trusted: false };
  }

  // Find matching entry in allow list
  const entry = findMatchingEntry(settings.permissions.allow, repoInfo);
  if (!entry) {
    return { trusted: false };
  }

  // Read file once (atomically)
  const fileContent = await Deno.readTextFile(vibeFilePath);

  // Determine whether to skip hash check
  // Priority: per-path setting > global setting > default (false)
  const shouldSkipHashCheck = entry.skipHashCheck ??
    settings.skipHashCheck ?? false;
  if (shouldSkipHashCheck) {
    console.warn(
      `Warning: Hash verification is disabled for ${vibeFilePath}`,
    );
    return { trusted: true, content: fileContent };
  }

  // Calculate hash from the already-read content
  const encoder = new TextEncoder();
  const contentBytes = encoder.encode(fileContent);
  const fileHash = await calculateHashFromContent(contentBytes);

  // Check if hash matches any stored hash
  const hashMatches = entry.hashes.includes(fileHash);
  if (hashMatches) {
    return { trusted: true, content: fileContent };
  }

  return { trusted: false };
}

export function getSettingsPath(): string {
  return USER_SETTINGS_FILE;
}

// Export for testing
export const _internal = {
  CURRENT_SCHEMA_VERSION,
  migrateSettings,
  getSchemaVersion,
  createDefaultSettings,
};
