import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { calculateFileHash, calculateHashFromContent } from "./hash.ts";
import { getRepoInfoFromPath, type RepoInfo } from "./git.ts";
import { VERSION } from "../version.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";
import { getConfigDir, ensureConfigDir } from "./config-path.ts";

function getUserSettingsFile(ctx: AppContext = getGlobalContext()): string {
  return join(getConfigDir(ctx), "settings.json");
}

// Current schema version
const CURRENT_SCHEMA_VERSION = 3;

// JSON Schema URL for editor autocompletion (version-tagged)
function getSettingsSchemaUrl(): string {
  // Extract semver from VERSION (e.g., "0.9.0+de25205" -> "v0.9.0")
  const semver = VERSION.split("+")[0];
  return `https://raw.githubusercontent.com/kexi/vibe/v${semver}/schemas/settings.schema.json`;
}

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
    allow: z.array(
      z.object({
        path: z.string(),
        hashes: z.array(z.string()),
        skipHashCheck: z.boolean().optional(),
      }),
    ),
    deny: z.array(z.string()),
  }),
});

// v3 schema - repository-based trust + worktree config
const SettingsSchemaV3 = z.object({
  $schema: z.string().optional(),
  version: z.literal(3),
  skipHashCheck: z.boolean().optional(),
  worktree: z
    .object({
      path_script: z.string().optional(),
    })
    .optional(),
  clean: z
    .object({
      fast_remove: z.boolean().optional(),
    })
    .optional(),
  permissions: z.object({
    allow: z.array(
      z.object({
        repoId: z.object({
          remoteUrl: z.string().optional(),
          repoRoot: z.string().optional(),
        }),
        relativePath: z.string(),
        hashes: z.array(z.string()),
        skipHashCheck: z.boolean().optional(),
      }),
    ),
    deny: z.array(z.string()),
  }),
});

// Current schema in use
const CurrentSettingsSchema = SettingsSchemaV3;
export type VibeSettings = z.infer<typeof CurrentSettingsSchema>;

// ===== Migration =====

type MigrationFn = (data: unknown, ctx: AppContext) => Promise<unknown>;

const migrations: Record<number, MigrationFn> = {
  // Migration from legacy (no version) to v1
  0: (data: unknown, _ctx: AppContext) => {
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
  1: async (data: unknown, ctx: AppContext) => {
    const v1 = SettingsSchemaV1.safeParse(data);
    if (!v1.success) {
      return data;
    }

    const allowWithHashes = await Promise.all(
      v1.data.permissions.allow.map(async (path) => {
        try {
          const hash = await calculateFileHash(path, ctx);
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
  2: async (data: unknown, ctx: AppContext) => {
    const v2 = SettingsSchemaV2.safeParse(data);
    if (!v2.success) {
      return data;
    }

    const migrationWarnings: string[] = [];
    const allowWithRepoInfo = await Promise.all(
      v2.data.permissions.allow.map(async (entry) => {
        try {
          // Get repository information from the absolute path
          const repoInfo = await getRepoInfoFromPath(entry.path, ctx);

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
              `Cannot determine repository for ${entry.path}. ` + `Using directory as fallback.`,
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

async function migrateSettings(
  data: unknown,
  ctx: AppContext = getGlobalContext(),
): Promise<unknown> {
  let currentData = data;
  let version = getSchemaVersion(currentData);

  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = migrations[version];
    const hasMigration = migration !== undefined;
    if (!hasMigration) {
      throw new Error(`Migration from version ${version} is not defined`);
    }
    currentData = await migration(currentData, ctx);
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

export async function loadUserSettings(
  ctx: AppContext = getGlobalContext(),
): Promise<VibeSettings> {
  try {
    const content = await ctx.runtime.fs.readTextFile(getUserSettingsFile(ctx));
    const rawData = JSON.parse(content);

    // Execute migration (async)
    const migratedData = await migrateSettings(rawData, ctx);

    // Schema validation
    const result = CurrentSettingsSchema.safeParse(migratedData);
    if (result.success) {
      // Update file if migration was performed
      const needsMigration = getSchemaVersion(rawData) !== CURRENT_SCHEMA_VERSION;
      if (needsMigration) {
        await saveUserSettings(result.data, ctx);
      }
      return result.data;
    }

    // Return default settings on validation failure
    console.error("Settings validation failed, using defaults:", result.error.message);
    return createDefaultSettings();
  } catch (error) {
    // Return default settings if file doesn't exist
    const isNotFound = ctx.runtime.errors.isNotFound(error);
    if (isNotFound) {
      return createDefaultSettings();
    }
    // Rethrow unexpected errors (permission errors, JSON parse errors, etc.)
    throw error;
  }
}

export async function saveUserSettings(
  settings: VibeSettings,
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  // Validate settings before saving
  const result = CurrentSettingsSchema.safeParse(settings);
  if (!result.success) {
    throw new Error(`Invalid settings schema: ${result.error.message}`);
  }

  await ensureConfigDir(ctx);

  // Always add $schema for editor autocompletion
  const settingsWithSchema = {
    $schema: getSettingsSchemaUrl(),
    ...settings,
  };
  const content = JSON.stringify(settingsWithSchema, null, 2) + "\n";

  // Use atomic write via temp file + rename to prevent corruption during concurrent writes
  // Use crypto.randomUUID() to ensure unique temp files for concurrent operations
  const tempFile = `${getUserSettingsFile(ctx)}.tmp.${Date.now()}.${crypto.randomUUID()}`;
  try {
    await ctx.runtime.fs.writeTextFile(tempFile, content);
    await ctx.runtime.fs.rename(tempFile, getUserSettingsFile(ctx));
  } catch (error) {
    // Clean up temp file if rename fails
    try {
      await ctx.runtime.fs.remove(tempFile);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
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

export async function addTrustedPath(
  path: string,
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  // Validate path is absolute
  if (!isAbsolute(path)) {
    throw new Error(
      `Path must be absolute: ${path}\n` + `Relative paths are not supported for security reasons.`,
    );
  }

  const settings = await loadUserSettings(ctx);

  // Get repository information
  const repoInfo = await getRepoInfoFromPath(path, ctx);
  if (!repoInfo) {
    throw new Error(
      `Cannot trust file outside of git repository: ${path}\n` +
        `Vibe requires configuration files to be within a git repository.`,
    );
  }

  // Calculate file hash
  const hash = await calculateFileHash(path, ctx);

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

  await saveUserSettings(settings, ctx);
}

export async function removeTrustedPath(
  path: string,
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const settings = await loadUserSettings(ctx);

  // Get repository information
  const repoInfo = await getRepoInfoFromPath(path, ctx);
  if (!repoInfo) {
    // Cannot determine repository, try to remove anyway if path matches
    console.warn(
      `Warning: Cannot determine repository for ${path}. ` + `Removal may not work correctly.`,
    );
    return;
  }

  // Find and remove matching entry
  const allowIndex = settings.permissions.allow.findIndex((entry) => {
    return (
      entry.relativePath === repoInfo.relativePath &&
      ((entry.repoId.remoteUrl &&
        repoInfo.remoteUrl &&
        entry.repoId.remoteUrl === repoInfo.remoteUrl) ||
        (entry.repoId.repoRoot && repoInfo.repoRoot && entry.repoId.repoRoot === repoInfo.repoRoot))
    );
  });

  const isInAllowList = allowIndex !== -1;
  if (isInAllowList) {
    settings.permissions.allow.splice(allowIndex, 1);
  }

  await saveUserSettings(settings, ctx);
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
 * @param ctx Application context
 * @returns true if the file is trusted
 */
export async function isTrusted(
  vibeFilePath: string,
  ctx: AppContext = getGlobalContext(),
): Promise<boolean> {
  const settings = await loadUserSettings(ctx);

  // Get repository information from file path
  const repoInfo = await getRepoInfoFromPath(vibeFilePath, ctx);
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
  const shouldSkipHashCheck = entry.skipHashCheck ?? settings.skipHashCheck ?? false;
  if (shouldSkipHashCheck) {
    console.warn(`Warning: Hash verification is disabled for ${vibeFilePath}`);
    return true; // Trust unconditionally if skip is enabled
  }

  // Calculate file hash
  const fileHash = await calculateFileHash(vibeFilePath, ctx);

  // Check if hash matches any stored hash
  const hashMatches = entry.hashes.includes(fileHash);
  return hashMatches;
}

/**
 * Atomically read file and verify trust to prevent TOCTOU attacks
 * @param vibeFilePath Path to the vibe config file
 * @param ctx Application context
 * @returns Object with trusted flag and file content if trusted
 */
export async function verifyTrustAndRead(
  vibeFilePath: string,
  ctx: AppContext = getGlobalContext(),
): Promise<{ trusted: boolean; content?: string }> {
  const settings = await loadUserSettings(ctx);

  // Get repository information from file path
  const repoInfo = await getRepoInfoFromPath(vibeFilePath, ctx);
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
  const fileContent = await ctx.runtime.fs.readTextFile(vibeFilePath);

  // Determine whether to skip hash check
  // Priority: per-path setting > global setting > default (false)
  const shouldSkipHashCheck = entry.skipHashCheck ?? settings.skipHashCheck ?? false;
  if (shouldSkipHashCheck) {
    console.warn(`Warning: Hash verification is disabled for ${vibeFilePath}`);
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

export function getSettingsPath(ctx: AppContext = getGlobalContext()): string {
  return getUserSettingsFile(ctx);
}

// Export for testing
export const _internal = {
  CURRENT_SCHEMA_VERSION,
  migrateSettings,
  getSchemaVersion,
  createDefaultSettings,
  getSettingsSchemaUrl,
};
