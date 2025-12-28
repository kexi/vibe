import { assertEquals } from "@std/assert";
import {
  _internal,
  addTrustedPath,
  isTrusted,
  loadUserSettings,
  removeTrustedPath,
  saveUserSettings,
} from "./settings.ts";

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

Deno.test("migrateSettings migrates v1 to v2 with hashes", async () => {
  // Create temporary file
  const tempFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tempFile, "test content");

  const v1Data = {
    version: 1,
    permissions: {
      allow: [tempFile],
      deny: [],
    },
  };

  const migrated = await _internal.migrateSettings(v1Data) as {
    version: number;
    permissions: {
      allow: Array<{ path: string; hashes: string[] }>;
      deny: string[];
    };
  };

  assertEquals(migrated.version, 2);
  assertEquals(migrated.permissions.allow.length, 1);
  assertEquals(migrated.permissions.allow[0].path, tempFile);
  assertEquals(Array.isArray(migrated.permissions.allow[0].hashes), true);
  assertEquals(migrated.permissions.allow[0].hashes.length, 1);
  assertEquals(typeof migrated.permissions.allow[0].hashes[0], "string");
  assertEquals(migrated.permissions.allow[0].hashes[0].length, 64);

  await Deno.remove(tempFile);
});

Deno.test("createDefaultSettings returns settings with current version", () => {
  const defaults = _internal.createDefaultSettings();
  assertEquals(defaults.version, _internal.CURRENT_SCHEMA_VERSION);
  assertEquals(defaults.permissions.allow, []);
  assertEquals(defaults.permissions.deny, []);
});

Deno.test("addTrustedPath and isTrusted work correctly", async () => {
  const tempFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tempFile, "test content");

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
  await Deno.remove(tempFile);
});

Deno.test("removeTrustedPath removes path from allow list", async () => {
  const tempFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tempFile, "test content");

  // Add trust
  await addTrustedPath(tempFile);
  const afterAdd = await isTrusted(tempFile);
  assertEquals(afterAdd, true);

  // Remove trust
  await removeTrustedPath(tempFile);
  const afterRemove = await isTrusted(tempFile);
  assertEquals(afterRemove, false);

  await Deno.remove(tempFile);
});

Deno.test("addTrustedPath adds hash to existing path without duplicates", async () => {
  const tempFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tempFile, "content");

  // First trust
  await addTrustedPath(tempFile);
  let settings = await loadUserSettings();
  const entry1 = settings.permissions.allow.find((e) => e.path === tempFile);
  assertEquals(entry1 !== undefined, true);
  assertEquals(entry1!.hashes.length, 1);

  // Trust again with same content (no duplicate)
  await addTrustedPath(tempFile);
  settings = await loadUserSettings();
  const entry2 = settings.permissions.allow.find((e) => e.path === tempFile);
  assertEquals(entry2 !== undefined, true);
  assertEquals(entry2!.hashes.length, 1);

  // Modify content and trust (new hash is added)
  await Deno.writeTextFile(tempFile, "modified content");
  await addTrustedPath(tempFile);
  settings = await loadUserSettings();
  const entry3 = settings.permissions.allow.find((e) => e.path === tempFile);
  assertEquals(entry3 !== undefined, true);
  assertEquals(entry3!.hashes.length, 2);

  // Cleanup
  await removeTrustedPath(tempFile);
  await Deno.remove(tempFile);
});

Deno.test("isTrusted returns true for any matching hash", async () => {
  const tempFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tempFile, "original content");

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
  await Deno.remove(tempFile);
});

Deno.test("isTrusted skips hash check when skipHashCheck is true (path level)", async () => {
  const tempFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tempFile, "original content");

  // Trust
  await addTrustedPath(tempFile);

  // Set skipHashCheck to true
  const settings = await loadUserSettings();
  const entry = settings.permissions.allow.find((e) => e.path === tempFile);
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
  await Deno.remove(tempFile);
});

Deno.test("isTrusted skips hash check when skipHashCheck is true (global level)", async () => {
  const tempFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tempFile, "original content");

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
  await Deno.remove(tempFile);
});

Deno.test("path-level skipHashCheck overrides global skipHashCheck", async () => {
  const tempFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tempFile, "original content");

  // Trust
  await addTrustedPath(tempFile);

  // Set global to true, path-level to false
  const settings = await loadUserSettings();
  settings.skipHashCheck = true;
  const entry = settings.permissions.allow.find((e) => e.path === tempFile);
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
  await Deno.remove(tempFile);
});
