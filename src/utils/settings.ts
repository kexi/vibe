import { join } from "@std/path";
import { z } from "zod";
import { calculateFileHash, calculateHashFromContent } from "./hash.ts";

// Settings file path
const CONFIG_DIR = join(Deno.env.get("HOME") ?? "", ".config", "vibe");
const USER_SETTINGS_FILE = join(CONFIG_DIR, "settings.json");

// Current schema version
const CURRENT_SCHEMA_VERSION = 2;

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

// Current schema in use
const CurrentSettingsSchema = SettingsSchemaV2;
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

// ===== Public API =====

export async function addTrustedPath(path: string): Promise<void> {
  const settings = await loadUserSettings();

  // Calculate file hash
  const hash = await calculateFileHash(path);

  // Remove from deny list (if present)
  const denyIndex = settings.permissions.deny.indexOf(path);
  const isInDenyList = denyIndex !== -1;
  if (isInDenyList) {
    settings.permissions.deny.splice(denyIndex, 1);
  }

  // Find existing entry in allow list
  const existingIndex = settings.permissions.allow.findIndex(
    (item) => item.path === path,
  );
  const isAlreadyAllowed = existingIndex !== -1;

  if (isAlreadyAllowed) {
    // Add hash to existing entry (with duplicate check and FIFO)
    const entry = settings.permissions.allow[existingIndex];
    const hashAlreadyExists = entry.hashes.includes(hash);
    if (!hashAlreadyExists) {
      entry.hashes.push(hash);
      // Apply FIFO: remove oldest hash if limit exceeded
      if (entry.hashes.length > MAX_HASH_HISTORY) {
        entry.hashes.shift(); // Remove first (oldest) element
      }
    }
  } else {
    // Create new entry
    settings.permissions.allow.push({ path, hashes: [hash] });
  }

  await saveUserSettings(settings);
}

export async function removeTrustedPath(path: string): Promise<void> {
  const settings = await loadUserSettings();

  const allowIndex = settings.permissions.allow.findIndex(
    (item) => item.path === path,
  );
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

  // Deny if in deny list
  const isDenied = settings.permissions.deny.includes(vibeFilePath);
  if (isDenied) {
    return false;
  }

  // Find entry in allow list
  const entry = settings.permissions.allow.find(
    (item) => item.path === vibeFilePath,
  );
  const isNotInAllowList = !entry;
  if (isNotInAllowList) {
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

  // Deny if in deny list
  const isDenied = settings.permissions.deny.includes(vibeFilePath);
  if (isDenied) {
    return { trusted: false };
  }

  // Find entry in allow list
  const entry = settings.permissions.allow.find(
    (item) => item.path === vibeFilePath,
  );
  const isNotInAllowList = !entry;
  if (isNotInAllowList) {
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
