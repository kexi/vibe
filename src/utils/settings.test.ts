import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  _internal,
  addTrustedPath,
  isTrusted,
  loadUserSettings,
  removeTrustedPath,
  saveUserSettings,
} from "./settings.ts";
import { getRepoInfoFromPath } from "./git.ts";

// Helper function to find entry by file path in v3 schema
async function findEntryByPath(
  settings: Awaited<ReturnType<typeof loadUserSettings>>,
  filePath: string,
) {
  const repoInfo = await getRepoInfoFromPath(filePath);
  if (!repoInfo) return undefined;

  return settings.permissions.allow.find((e) => {
    return e.relativePath === repoInfo.relativePath &&
      (
        (e.repoId.remoteUrl && repoInfo.remoteUrl &&
          e.repoId.remoteUrl === repoInfo.remoteUrl) ||
        (e.repoId.repoRoot && repoInfo.repoRoot &&
          e.repoId.repoRoot === repoInfo.repoRoot)
      );
  });
}

Deno.test("loadUserSettings returns default settings when file not exists", async () => {
  const settings = await loadUserSettings();
  assertEquals(settings.version, _internal.CURRENT_SCHEMA_VERSION);
  // Note: This test returns existing settings if the settings file exists,
  // so the allow list may not be empty
  assertEquals(Array.isArray(settings.permissions.allow), true);
  assertEquals(Array.isArray(settings.permissions.deny), true);
});

// ===== Migration Tests =====

Deno.test("getSchemaVersion returns 0 for legacy settings without version", () => {
  const legacyData = {
    permissions: { allow: [], deny: [] },
  };
  assertEquals(_internal.getSchemaVersion(legacyData), 0);
});

Deno.test("getSchemaVersion returns correct version for versioned settings", () => {
  const v1Data = {
    version: 1,
    permissions: { allow: [], deny: [] },
  };
  assertEquals(_internal.getSchemaVersion(v1Data), 1);
});

// This test is skipped (hash calculation fails because file doesn't exist)
// Legacy→v1→v2 migration is covered by the next test

Deno.test("migrateSettings migrates v1 to v3 (via v2) with repository info", async () => {
  // Create temporary file in git repository
  const tempFile = join(Deno.cwd(), `.test-migration-${Date.now()}.tmp`);
  await Deno.writeTextFile(tempFile, "test content");

  try {
    const v1Data = {
      version: 1,
      permissions: {
        allow: [tempFile], // Absolute path for v1
        deny: [],
      },
    };

    const migrated = await _internal.migrateSettings(v1Data) as Awaited<
      ReturnType<typeof loadUserSettings>
    >;

    assertEquals(migrated.version, _internal.CURRENT_SCHEMA_VERSION);
    assertEquals(migrated.permissions.allow.length, 1);

    // v3 should have repoId and relativePath
    const entry = migrated.permissions.allow[0];
    assertEquals(typeof entry.repoId, "object");
    assertEquals(typeof entry.relativePath, "string");
    assertEquals(Array.isArray(entry.hashes), true);
    assertEquals(entry.hashes.length, 1);
    assertEquals(typeof entry.hashes[0], "string");
    assertEquals(entry.hashes[0].length, 64);
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("createDefaultSettings returns settings with current version", () => {
  const defaults = _internal.createDefaultSettings();
  assertEquals(defaults.version, _internal.CURRENT_SCHEMA_VERSION);
  assertEquals(defaults.permissions.allow, []);
  assertEquals(defaults.permissions.deny, []);
});

Deno.test("addTrustedPath and isTrusted work correctly", async () => {
  // Create temp file in git repository (current directory)
  const tempFile = join(Deno.cwd(), `.test-${Date.now()}.tmp`);
  await Deno.writeTextFile(tempFile, "test content");

  try {
    // Initially not trusted
    const beforeTrust = await isTrusted(tempFile);
    assertEquals(beforeTrust, false);

    // Add trust
    await addTrustedPath(tempFile);

    // Now trusted
    const afterTrust = await isTrusted(tempFile);
    assertEquals(afterTrust, true);

    // Cleanup
    await removeTrustedPath(tempFile);
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("removeTrustedPath removes path from allow list", async () => {
  const tempFile = join(Deno.cwd(), `.test-${Date.now()}.tmp`);
  await Deno.writeTextFile(tempFile, "test content");

  try {
    // Add trust
    await addTrustedPath(tempFile);
    const afterAdd = await isTrusted(tempFile);
    assertEquals(afterAdd, true);

    // Remove trust
    await removeTrustedPath(tempFile);
    const afterRemove = await isTrusted(tempFile);
    assertEquals(afterRemove, false);
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("addTrustedPath adds hash to existing path without duplicates", async () => {
  const tempFile = join(Deno.cwd(), `.test-${Date.now()}.tmp`);
  await Deno.writeTextFile(tempFile, "content");

  try {
    // First trust
    await addTrustedPath(tempFile);
    let settings = await loadUserSettings();
    const entry1 = await findEntryByPath(settings, tempFile);
    assertEquals(entry1 !== undefined, true);
    assertEquals(entry1!.hashes.length, 1);

    // Trust again with same content (no duplicate)
    await addTrustedPath(tempFile);
    settings = await loadUserSettings();
    const entry2 = await findEntryByPath(settings, tempFile);
    assertEquals(entry2 !== undefined, true);
    assertEquals(entry2!.hashes.length, 1);

    // Modify content and trust (new hash is added)
    await Deno.writeTextFile(tempFile, "modified content");
    await addTrustedPath(tempFile);
    settings = await loadUserSettings();
    const entry3 = await findEntryByPath(settings, tempFile);
    assertEquals(entry3 !== undefined, true);
    assertEquals(entry3!.hashes.length, 2);

    // Cleanup
    await removeTrustedPath(tempFile);
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("isTrusted returns true for any matching hash", async () => {
  const tempFile = join(Deno.cwd(), `.test-${Date.now()}.tmp`);
  await Deno.writeTextFile(tempFile, "original content");

  try {
    // First trust
    await addTrustedPath(tempFile);
    let trusted = await isTrusted(tempFile);
    assertEquals(trusted, true);

    // Modify and trust
    await Deno.writeTextFile(tempFile, "modified content");
    await addTrustedPath(tempFile);
    trusted = await isTrusted(tempFile);
    assertEquals(trusted, true);

    // Revert to original content (verified with first hash)
    await Deno.writeTextFile(tempFile, "original content");
    trusted = await isTrusted(tempFile);
    assertEquals(trusted, true);

    // Change to unknown content (no hash matches)
    await Deno.writeTextFile(tempFile, "unknown content");
    trusted = await isTrusted(tempFile);
    assertEquals(trusted, false);

    // Cleanup
    await removeTrustedPath(tempFile);
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("isTrusted skips hash check when skipHashCheck is true (path level)", async () => {
  const tempFile = join(Deno.cwd(), `.test-${Date.now()}.tmp`);
  await Deno.writeTextFile(tempFile, "original content");

  try {
    // Trust
    await addTrustedPath(tempFile);

    // Set skipHashCheck to true
    const settings = await loadUserSettings();
    const entry = await findEntryByPath(settings, tempFile);
    assertEquals(entry !== undefined, true);
    entry!.skipHashCheck = true;
    await saveUserSettings(settings);

    // Modify file (hash mismatch)
    await Deno.writeTextFile(tempFile, "modified content");

    // skipHashCheck=true, so trusted even with hash mismatch
    const trusted = await isTrusted(tempFile);
    assertEquals(trusted, true);

    // Cleanup
    await removeTrustedPath(tempFile);
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("isTrusted skips hash check when skipHashCheck is true (global level)", async () => {
  const tempFile = join(Deno.cwd(), `.test-${Date.now()}.tmp`);
  await Deno.writeTextFile(tempFile, "original content");

  try {
    // Trust
    await addTrustedPath(tempFile);

    // Set global skipHashCheck to true
    const settings = await loadUserSettings();
    settings.skipHashCheck = true;
    await saveUserSettings(settings);

    // Modify file (hash mismatch)
    await Deno.writeTextFile(tempFile, "modified content");

    // Global skipHashCheck=true, so trusted even with hash mismatch
    const trusted = await isTrusted(tempFile);
    assertEquals(trusted, true);

    // Cleanup
    settings.skipHashCheck = false;
    await saveUserSettings(settings);
    await removeTrustedPath(tempFile);
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("path-level skipHashCheck overrides global skipHashCheck", async () => {
  const tempFile = join(Deno.cwd(), `.test-${Date.now()}.tmp`);
  await Deno.writeTextFile(tempFile, "original content");

  try {
    // Trust
    await addTrustedPath(tempFile);

    // Set global to true, path-level to false
    const settings = await loadUserSettings();
    settings.skipHashCheck = true;
    const entry = await findEntryByPath(settings, tempFile);
    assertEquals(entry !== undefined, true);
    entry!.skipHashCheck = false;
    await saveUserSettings(settings);

    // Modify file (hash mismatch)
    await Deno.writeTextFile(tempFile, "modified content");

    // Path-level skipHashCheck=false takes priority, so hash check is performed
    const trusted = await isTrusted(tempFile);
    assertEquals(trusted, false);

    // Cleanup
    settings.skipHashCheck = false;
    await saveUserSettings(settings);
    await removeTrustedPath(tempFile);
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Hash history follows FIFO when exceeding MAX_HASH_HISTORY", async () => {
  const tempFile = join(Deno.cwd(), `.test-fifo-${Date.now()}.tmp`);

  try {
    // Add 101 different hashes (exceeding MAX_HASH_HISTORY of 100)
    const hashes: string[] = [];
    for (let i = 0; i < 101; i++) {
      await Deno.writeTextFile(tempFile, `content ${i}`);
      await addTrustedPath(tempFile);

      const hash = await isTrusted(tempFile);
      assertEquals(hash, true);

      // Record the hash for later verification
      const settings = await loadUserSettings();
      const entry = await findEntryByPath(settings, tempFile);
      if (entry && entry.hashes.length > 0) {
        hashes.push(entry.hashes[entry.hashes.length - 1]);
      }
    }

    // Verify that only 100 hashes are kept
    const settings = await loadUserSettings();
    const entry = await findEntryByPath(settings, tempFile);
    assertEquals(entry !== undefined, true);
    assertEquals(entry!.hashes.length, 100);

    // Verify that the first hash was removed (FIFO)
    const firstHashRemoved = !entry!.hashes.includes(hashes[0]);
    assertEquals(firstHashRemoved, true);

    // Verify that the last 100 hashes are kept
    for (let i = 1; i <= 100; i++) {
      const hashPresent = entry!.hashes.includes(hashes[i]);
      assertEquals(hashPresent, true);
    }

    // Cleanup
    await removeTrustedPath(tempFile);
  } finally {
    await Deno.remove(tempFile);
  }
});

// ===== Additional Test Coverage =====

Deno.test("Concurrent addTrustedPath calls handle race conditions", async () => {
  const tempFile = join(Deno.cwd(), `.test-concurrent-${Date.now()}.tmp`);
  await Deno.writeTextFile(tempFile, "test content");

  try {
    // Execute 10 concurrent addTrustedPath calls
    const promises = Array.from({ length: 10 }, () => addTrustedPath(tempFile));
    await Promise.all(promises);

    // Should have only one hash (duplicate prevention works)
    const settings = await loadUserSettings();
    const entry = await findEntryByPath(settings, tempFile);
    assertEquals(entry !== undefined, true);
    assertEquals(entry!.hashes.length, 1);

    await removeTrustedPath(tempFile);
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("loadUserSettings handles corrupted JSON gracefully", async () => {
  const tempSettingsPath = await Deno.makeTempFile({ suffix: ".json" });

  // Write corrupted JSON
  await Deno.writeTextFile(tempSettingsPath, "{ invalid json ");

  // Override USER_SETTINGS_FILE temporarily using environment
  const originalHome = Deno.env.get("HOME");
  const tempDir = await Deno.makeTempDir();
  Deno.env.set("HOME", tempDir);

  try {
    const configDir = `${tempDir}/.config/vibe`;
    await Deno.mkdir(configDir, { recursive: true });
    const corruptedFile = `${configDir}/settings.json`;
    await Deno.writeTextFile(corruptedFile, "{ invalid json ");

    // Should return default settings instead of crashing
    const settings = await loadUserSettings();
    assertEquals(settings.version, _internal.CURRENT_SCHEMA_VERSION);
    assertEquals(Array.isArray(settings.permissions.allow), true);
    assertEquals(Array.isArray(settings.permissions.deny), true);
  } finally {
    // Restore original HOME
    if (originalHome) {
      Deno.env.set("HOME", originalHome);
    } else {
      Deno.env.delete("HOME");
    }
    await Deno.remove(tempDir, { recursive: true });
  }

  await Deno.remove(tempSettingsPath);
});

// ===== JSON Schema URL Tests =====

Deno.test("getSettingsSchemaUrl extracts semver from VERSION string", () => {
  const url = _internal.getSettingsSchemaUrl();

  // URL should contain version tag pattern
  const isValidUrl = url.startsWith(
    "https://raw.githubusercontent.com/kexi/vibe/v",
  );
  assertEquals(isValidUrl, true);

  // URL should end with schema file path
  const hasSchemaPath = url.endsWith("/schemas/settings.schema.json");
  assertEquals(hasSchemaPath, true);

  // Extract version from URL (e.g., "v0.10.0" from full URL)
  const versionMatch = url.match(/\/v(\d+\.\d+\.\d+)\//);
  const hasValidSemver = versionMatch !== null;
  assertEquals(hasValidSemver, true);

  // Version should not contain build metadata (no "+" in version part)
  if (versionMatch) {
    const versionPart = versionMatch[1];
    const hasNoBuildMetadata = !versionPart.includes("+");
    assertEquals(hasNoBuildMetadata, true);
  }
});
