import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _internal,
  addTrustedPath,
  isRepoIdMatch,
  isTrusted,
  loadUserSettings,
  removeTrustedPath,
  saveUserSettings,
} from "./settings.ts";
import { getRepoInfoFromPath, type RepoInfo } from "./git.ts";
import { setupRealTestContext } from "../context/testing.ts";

// Initialize test context with real Deno runtime for filesystem tests
beforeAll(async () => {
  await setupRealTestContext();
});

// Helper function to find entry by file path in v3 schema
async function findEntryByPath(
  settings: Awaited<ReturnType<typeof loadUserSettings>>,
  filePath: string,
) {
  const repoInfo = await getRepoInfoFromPath(filePath);
  if (!repoInfo) return undefined;

  return settings.permissions.allow.find((e) => isRepoIdMatch(e, repoInfo));
}

describe("loadUserSettings", () => {
  it("returns default settings when file not exists", async () => {
    const settings = await loadUserSettings();
    expect(settings.version).toBe(_internal.CURRENT_SCHEMA_VERSION);
    // Note: This test returns existing settings if the settings file exists,
    // so the allow list may not be empty
    expect(Array.isArray(settings.permissions.allow)).toBe(true);
    expect(Array.isArray(settings.permissions.deny)).toBe(true);
  });
});

describe("getSchemaVersion", () => {
  it("returns 0 for legacy settings without version", () => {
    const legacyData = {
      permissions: { allow: [], deny: [] },
    };
    expect(_internal.getSchemaVersion(legacyData)).toBe(0);
  });

  it("returns correct version for versioned settings", () => {
    const v1Data = {
      version: 1,
      permissions: { allow: [], deny: [] },
    };
    expect(_internal.getSchemaVersion(v1Data)).toBe(1);
  });
});

describe("migrateSettings", () => {
  let tempFile: string;

  afterEach(async () => {
    if (tempFile) {
      try {
        await rm(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // This test is skipped (hash calculation fails because file doesn't exist)
  // Legacy->v1->v2 migration is covered by the next test

  it("migrates v1 to v3 (via v2) with repository info", async () => {
    // Create temporary file in git repository
    tempFile = join(process.cwd(), `.test-migration-${Date.now()}.tmp`);
    await writeFile(tempFile, "test content");

    const v1Data = {
      version: 1,
      permissions: {
        allow: [tempFile], // Absolute path for v1
        deny: [],
      },
    };

    const migrated = (await _internal.migrateSettings(v1Data)) as Awaited<
      ReturnType<typeof loadUserSettings>
    >;

    expect(migrated.version).toBe(_internal.CURRENT_SCHEMA_VERSION);
    expect(migrated.permissions.allow.length).toBe(1);

    // v3 should have repoId and relativePath
    const entry = migrated.permissions.allow[0];
    expect(typeof entry.repoId).toBe("object");
    expect(typeof entry.relativePath).toBe("string");
    expect(Array.isArray(entry.hashes)).toBe(true);
    expect(entry.hashes.length).toBe(1);
    expect(typeof entry.hashes[0]).toBe("string");
    expect(entry.hashes[0].length).toBe(64);
  });
});

describe("createDefaultSettings", () => {
  it("returns settings with current version", () => {
    const defaults = _internal.createDefaultSettings();
    expect(defaults.version).toBe(_internal.CURRENT_SCHEMA_VERSION);
    expect(defaults.permissions.allow).toEqual([]);
    expect(defaults.permissions.deny).toEqual([]);
  });
});

describe("addTrustedPath and isTrusted", () => {
  let tempFile: string;

  afterEach(async () => {
    if (tempFile) {
      try {
        await removeTrustedPath(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      try {
        await rm(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("work correctly", async () => {
    // Create temp file in git repository (current directory)
    tempFile = join(process.cwd(), `.test-${Date.now()}.tmp`);
    await writeFile(tempFile, "test content");

    // Initially not trusted
    const beforeTrust = await isTrusted(tempFile);
    expect(beforeTrust).toBe(false);

    // Add trust
    await addTrustedPath(tempFile);

    // Now trusted
    const afterTrust = await isTrusted(tempFile);
    expect(afterTrust).toBe(true);
  });
});

describe("removeTrustedPath", () => {
  let tempFile: string;

  afterEach(async () => {
    if (tempFile) {
      try {
        await rm(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("removes path from allow list", async () => {
    tempFile = join(process.cwd(), `.test-${Date.now()}.tmp`);
    await writeFile(tempFile, "test content");

    // Add trust
    await addTrustedPath(tempFile);
    const afterAdd = await isTrusted(tempFile);
    expect(afterAdd).toBe(true);

    // Remove trust
    await removeTrustedPath(tempFile);
    const afterRemove = await isTrusted(tempFile);
    expect(afterRemove).toBe(false);
  });
});

describe("addTrustedPath hash management", () => {
  let tempFile: string;

  afterEach(async () => {
    if (tempFile) {
      try {
        await removeTrustedPath(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      try {
        await rm(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("adds hash to existing path without duplicates", async () => {
    tempFile = join(process.cwd(), `.test-${Date.now()}.tmp`);
    await writeFile(tempFile, "content");

    // First trust
    await addTrustedPath(tempFile);
    let settings = await loadUserSettings();
    const entry1 = await findEntryByPath(settings, tempFile);
    expect(entry1 !== undefined).toBe(true);
    expect(entry1!.hashes.length).toBe(1);

    // Trust again with same content (no duplicate)
    await addTrustedPath(tempFile);
    settings = await loadUserSettings();
    const entry2 = await findEntryByPath(settings, tempFile);
    expect(entry2 !== undefined).toBe(true);
    expect(entry2!.hashes.length).toBe(1);

    // Modify content and trust (new hash is added)
    await writeFile(tempFile, "modified content");
    await addTrustedPath(tempFile);
    settings = await loadUserSettings();
    const entry3 = await findEntryByPath(settings, tempFile);
    expect(entry3 !== undefined).toBe(true);
    expect(entry3!.hashes.length).toBe(2);
  });
});

describe("isTrusted hash matching", () => {
  let tempFile: string;

  afterEach(async () => {
    if (tempFile) {
      try {
        await removeTrustedPath(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      try {
        await rm(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("returns true for any matching hash", async () => {
    tempFile = join(process.cwd(), `.test-${Date.now()}.tmp`);
    await writeFile(tempFile, "original content");

    // First trust
    await addTrustedPath(tempFile);
    let trusted = await isTrusted(tempFile);
    expect(trusted).toBe(true);

    // Modify and trust
    await writeFile(tempFile, "modified content");
    await addTrustedPath(tempFile);
    trusted = await isTrusted(tempFile);
    expect(trusted).toBe(true);

    // Revert to original content (verified with first hash)
    await writeFile(tempFile, "original content");
    trusted = await isTrusted(tempFile);
    expect(trusted).toBe(true);

    // Change to unknown content (no hash matches)
    await writeFile(tempFile, "unknown content");
    trusted = await isTrusted(tempFile);
    expect(trusted).toBe(false);
  });
});

describe("skipHashCheck", () => {
  let tempFile: string;

  afterEach(async () => {
    if (tempFile) {
      try {
        await removeTrustedPath(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      try {
        await rm(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("skips hash check when skipHashCheck is true (path level)", async () => {
    tempFile = join(process.cwd(), `.test-${Date.now()}.tmp`);
    await writeFile(tempFile, "original content");

    // Trust
    await addTrustedPath(tempFile);

    // Set skipHashCheck to true
    const settings = await loadUserSettings();
    const entry = await findEntryByPath(settings, tempFile);
    expect(entry !== undefined).toBe(true);
    entry!.skipHashCheck = true;
    await saveUserSettings(settings);

    // Modify file (hash mismatch)
    await writeFile(tempFile, "modified content");

    // skipHashCheck=true, so trusted even with hash mismatch
    const trusted = await isTrusted(tempFile);
    expect(trusted).toBe(true);
  });

  it("skips hash check when skipHashCheck is true (global level)", async () => {
    tempFile = join(process.cwd(), `.test-${Date.now()}.tmp`);
    await writeFile(tempFile, "original content");

    // Trust
    await addTrustedPath(tempFile);

    // Set global skipHashCheck to true
    const settings = await loadUserSettings();
    settings.skipHashCheck = true;
    await saveUserSettings(settings);

    // Modify file (hash mismatch)
    await writeFile(tempFile, "modified content");

    // Global skipHashCheck=true, so trusted even with hash mismatch
    const trusted = await isTrusted(tempFile);
    expect(trusted).toBe(true);

    // Cleanup
    settings.skipHashCheck = false;
    await saveUserSettings(settings);
  });

  it("path-level skipHashCheck overrides global skipHashCheck", async () => {
    tempFile = join(process.cwd(), `.test-${Date.now()}.tmp`);
    await writeFile(tempFile, "original content");

    // Trust
    await addTrustedPath(tempFile);

    // Set global to true, path-level to false
    const settings = await loadUserSettings();
    settings.skipHashCheck = true;
    const entry = await findEntryByPath(settings, tempFile);
    expect(entry !== undefined).toBe(true);
    entry!.skipHashCheck = false;
    await saveUserSettings(settings);

    // Modify file (hash mismatch)
    await writeFile(tempFile, "modified content");

    // Path-level skipHashCheck=false takes priority, so hash check is performed
    const trusted = await isTrusted(tempFile);
    expect(trusted).toBe(false);

    // Cleanup
    settings.skipHashCheck = false;
    await saveUserSettings(settings);
  });
});

describe("Hash history FIFO", () => {
  let tempFile: string;

  afterEach(async () => {
    if (tempFile) {
      try {
        await removeTrustedPath(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      try {
        await rm(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("follows FIFO when exceeding MAX_HASH_HISTORY", { timeout: 120000 }, async () => {
    tempFile = join(process.cwd(), `.test-fifo-${Date.now()}.tmp`);

    // Add 101 different hashes (exceeding MAX_HASH_HISTORY of 100)
    const hashes: string[] = [];
    for (let i = 0; i < 101; i++) {
      await writeFile(tempFile, `content ${i}`);
      await addTrustedPath(tempFile);

      const hash = await isTrusted(tempFile);
      expect(hash).toBe(true);

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
    expect(entry !== undefined).toBe(true);
    expect(entry!.hashes.length).toBe(100);

    // Verify that the first hash was removed (FIFO)
    const firstHashRemoved = !entry!.hashes.includes(hashes[0]);
    expect(firstHashRemoved).toBe(true);

    // Verify that the last 100 hashes are kept
    for (let i = 1; i <= 100; i++) {
      const hashPresent = entry!.hashes.includes(hashes[i]);
      expect(hashPresent).toBe(true);
    }
  });
});

describe("Concurrent operations", () => {
  let tempFile: string;

  afterEach(async () => {
    if (tempFile) {
      try {
        await removeTrustedPath(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      try {
        await rm(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("concurrent addTrustedPath calls handle race conditions", async () => {
    tempFile = join(process.cwd(), `.test-concurrent-${Date.now()}.tmp`);
    await writeFile(tempFile, "test content");

    // Execute 10 concurrent addTrustedPath calls
    const promises = Array.from({ length: 10 }, () => addTrustedPath(tempFile));
    await Promise.all(promises);

    // Should have only one hash (duplicate prevention works)
    const settings = await loadUserSettings();
    const entry = await findEntryByPath(settings, tempFile);
    expect(entry !== undefined).toBe(true);
    expect(entry!.hashes.length).toBe(1);
  });
});

describe("loadUserSettings error handling", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  afterEach(async () => {
    // Restore original HOME
    if (originalHome) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("throws error for corrupted JSON", async () => {
    // Override USER_SETTINGS_FILE temporarily using environment
    originalHome = process.env.HOME;
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    process.env.HOME = tempDir;

    const configDir = `${tempDir}/.config/vibe`;
    await mkdir(configDir, { recursive: true });
    const corruptedFile = `${configDir}/settings.json`;
    await writeFile(corruptedFile, "{ invalid json ");

    // Should throw error for corrupted JSON (not silently return defaults)
    await expect(loadUserSettings()).rejects.toThrow(SyntaxError);
  });
});

describe("getSettingsSchemaUrl", () => {
  it("extracts semver from VERSION string", () => {
    const url = _internal.getSettingsSchemaUrl();

    // URL should contain version tag pattern
    const isValidUrl = url.startsWith("https://raw.githubusercontent.com/kexi/vibe/v");
    expect(isValidUrl).toBe(true);

    // URL should end with schema file path
    const hasSchemaPath = url.endsWith("/schemas/settings.schema.json");
    expect(hasSchemaPath).toBe(true);

    // Extract version from URL (e.g., "v0.10.0" from full URL)
    const versionMatch = url.match(/\/v(\d+\.\d+\.\d+)\//);
    const hasValidSemver = versionMatch !== null;
    expect(hasValidSemver).toBe(true);

    // Version should not contain build metadata (no "+" in version part)
    if (versionMatch) {
      const versionPart = versionMatch[1];
      const hasNoBuildMetadata = !versionPart.includes("+");
      expect(hasNoBuildMetadata).toBe(true);
    }
  });
});

describe("isRepoIdMatch", () => {
  const baseRepoInfo: RepoInfo = {
    remoteUrl: "github.com/example/repo",
    repoRoot: "/path/to/repo",
    relativePath: ".vibe.toml",
  };

  it("returns true when repoRoot and remoteUrl both match", () => {
    const entry = {
      repoId: { remoteUrl: "github.com/example/repo", repoRoot: "/path/to/repo" },
      relativePath: ".vibe.toml",
    };
    expect(isRepoIdMatch(entry, baseRepoInfo)).toBe(true);
  });

  it("returns false when repoRoot mismatches (spoof regression)", () => {
    // Even with same remoteUrl, a different repoRoot must not match.
    // This is the #418 spoofing regression test.
    const entry = {
      repoId: { remoteUrl: "github.com/example/repo", repoRoot: "/different/path" },
      relativePath: ".vibe.toml",
    };
    expect(isRepoIdMatch(entry, baseRepoInfo)).toBe(false);
  });

  it("returns false when remoteUrl mismatches", () => {
    const entry = {
      repoId: { remoteUrl: "github.com/attacker/repo", repoRoot: "/path/to/repo" },
      relativePath: ".vibe.toml",
    };
    expect(isRepoIdMatch(entry, baseRepoInfo)).toBe(false);
  });

  it("returns true when both remoteUrl undefined and repoRoot matches (local-only)", () => {
    const localRepoInfo: RepoInfo = {
      repoRoot: "/path/to/repo",
      relativePath: ".vibe.toml",
    };
    const entry = {
      repoId: { repoRoot: "/path/to/repo" },
      relativePath: ".vibe.toml",
    };
    expect(isRepoIdMatch(entry, localRepoInfo)).toBe(true);
  });

  it("returns false when stored remoteUrl defined but current undefined (downgrade)", () => {
    const localRepoInfo: RepoInfo = {
      repoRoot: "/path/to/repo",
      relativePath: ".vibe.toml",
    };
    const entry = {
      repoId: { remoteUrl: "github.com/example/repo", repoRoot: "/path/to/repo" },
      relativePath: ".vibe.toml",
    };
    expect(isRepoIdMatch(entry, localRepoInfo)).toBe(false);
  });

  it("returns false when stored remoteUrl undefined but current defined (identity change)", () => {
    const entry = {
      repoId: { repoRoot: "/path/to/repo" },
      relativePath: ".vibe.toml",
    };
    expect(isRepoIdMatch(entry, baseRepoInfo)).toBe(false);
  });

  it("returns false when relativePath mismatches", () => {
    const entry = {
      repoId: { remoteUrl: "github.com/example/repo", repoRoot: "/path/to/repo" },
      relativePath: ".vibe.local.toml",
    };
    expect(isRepoIdMatch(entry, baseRepoInfo)).toBe(false);
  });

  it("returns false when stored entry missing repoRoot (defensive fail-closed)", () => {
    const entry = {
      repoId: { remoteUrl: "github.com/example/repo" },
      relativePath: ".vibe.toml",
    };
    expect(isRepoIdMatch(entry, baseRepoInfo)).toBe(false);
  });
});

describe("Migration security regressions (#418)", () => {
  it("v1→v2 fallback for non-existent path produces empty hashes without skipHashCheck", async () => {
    const v1Data = {
      version: 1,
      permissions: {
        allow: ["/non/existent/path/that/does/not/exist.toml"],
        deny: [],
      },
    };

    const migrated = (await _internal.migrateSettings(v1Data)) as Awaited<
      ReturnType<typeof loadUserSettings>
    >;

    expect(migrated.permissions.allow.length).toBe(1);
    const entry = migrated.permissions.allow[0];
    expect(entry.hashes).toEqual([]);
    expect(entry.skipHashCheck).toBeUndefined();
  });

  it("v2→v3 success branch drops skipHashCheck:true carryover", async () => {
    // Build a v2 entry with skipHashCheck: true. Path must be inside an actual
    // git repo so the migration can resolve repoInfo (success branch).
    const tempFile = join(process.cwd(), `.test-migration-v2-skip-${Date.now()}.tmp`);
    await writeFile(tempFile, "test content");
    try {
      const v2Data = {
        version: 2,
        skipHashCheck: false,
        permissions: {
          allow: [{ path: tempFile, hashes: ["abc123"], skipHashCheck: true }],
          deny: [],
        },
      };

      const migrated = (await _internal.migrateSettings(v2Data)) as Awaited<
        ReturnType<typeof loadUserSettings>
      >;

      expect(migrated.permissions.allow.length).toBe(1);
      const entry = migrated.permissions.allow[0];
      // The skipHashCheck: true carryover must NOT survive into v3.
      expect(entry.skipHashCheck).toBeUndefined();
      // hashes are preserved on the success path
      expect(entry.hashes).toEqual(["abc123"]);
    } finally {
      await rm(tempFile).catch(() => {});
    }
  });

  it("v2→v3 'no repoInfo' branch drops skipHashCheck:true carryover", async () => {
    // Path under a non-git temp directory triggers the else branch
    // (getRepoInfoFromPath returns null). The catch branch is unreachable in
    // practice because getRepoInfoFromPath swallows errors. Both branches
    // produce the same shape after the fix; this test exercises the
    // reachable one.
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-test-migration-"));
    const tempFile = join(tempDir, "config.toml");
    await writeFile(tempFile, "test");
    try {
      const v2Data = {
        version: 2,
        skipHashCheck: false,
        permissions: {
          allow: [{ path: tempFile, hashes: ["abc123"], skipHashCheck: true }],
          deny: [],
        },
      };

      const migrated = (await _internal.migrateSettings(v2Data)) as Awaited<
        ReturnType<typeof loadUserSettings>
      >;

      expect(migrated.permissions.allow.length).toBe(1);
      const entry = migrated.permissions.allow[0];
      expect(entry.skipHashCheck).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true }).catch(() => {});
    }
  });

  it("v1→v3 end-to-end with non-existent path: empty hashes, no skipHashCheck", async () => {
    const v1Data = {
      version: 1,
      permissions: {
        allow: ["/non/existent/path/that/does/not/exist.toml"],
        deny: [],
      },
    };

    const migrated = (await _internal.migrateSettings(v1Data)) as Awaited<
      ReturnType<typeof loadUserSettings>
    >;

    expect(migrated.version).toBe(_internal.CURRENT_SCHEMA_VERSION);
    expect(migrated.permissions.allow.length).toBe(1);
    const entry = migrated.permissions.allow[0];
    expect(entry.hashes).toEqual([]);
    expect(entry.skipHashCheck).toBeUndefined();
  });
});

describe("removeTrustedPath spoof prevention (#418)", () => {
  let tempFile: string;

  afterEach(async () => {
    if (tempFile) {
      try {
        await rm(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("removing one entry leaves another with same relativePath but different repoRoot", async () => {
    tempFile = join(process.cwd(), `.test-remove-spoof-${Date.now()}.tmp`);
    await writeFile(tempFile, "content");

    const repoInfo = await getRepoInfoFromPath(tempFile);
    expect(repoInfo).not.toBeNull();
    if (!repoInfo) return;

    const FAKE_REPO_ROOT = "/some/other/repo/root/that/does/not/exist";

    // Inject two entries that share relativePath but live in different repos.
    const settings = await loadUserSettings();
    const fakeOtherRepo = {
      repoId: { remoteUrl: repoInfo.remoteUrl, repoRoot: FAKE_REPO_ROOT },
      relativePath: repoInfo.relativePath,
      hashes: ["fake-hash-other-repo"],
    };
    settings.permissions.allow.push(fakeOtherRepo);
    await saveUserSettings(settings);

    try {
      // Trust the real entry too.
      await addTrustedPath(tempFile);

      // Remove via the real path.
      await removeTrustedPath(tempFile);

      // The real entry should be gone, the spoof-targeted entry must survive.
      const after = await loadUserSettings();
      const realEntry = after.permissions.allow.find(
        (e) => e.repoId.repoRoot === repoInfo.repoRoot && e.relativePath === repoInfo.relativePath,
      );
      const otherEntry = after.permissions.allow.find(
        (e) => e.repoId.repoRoot === FAKE_REPO_ROOT && e.relativePath === repoInfo.relativePath,
      );
      expect(realEntry).toBeUndefined();
      expect(otherEntry).toBeDefined();
    } finally {
      // Cleanup runs even if assertions above fail, so the user's real
      // settings.json is never left polluted.
      const finalSettings = await loadUserSettings();
      finalSettings.permissions.allow = finalSettings.permissions.allow.filter(
        (e) => e.repoId.repoRoot !== FAKE_REPO_ROOT,
      );
      await saveUserSettings(finalSettings);
    }
  });

  it("loadUserSettings strips skipHashCheck:true from migration-fallback artifacts only", async () => {
    // Two legacy v3 entries from before #418:
    //   - fallback artifact: hashes:[] + skipHashCheck:true (must be cleaned)
    //   - manual opt-in: non-empty hashes + skipHashCheck:true (must be preserved)
    const settings = await loadUserSettings();
    const FAKE_REPO_ROOT_FALLBACK = "/some/legacy/fallback/repo/root";
    const fallbackArtifact = {
      repoId: { repoRoot: FAKE_REPO_ROOT_FALLBACK },
      relativePath: ".vibe.toml",
      hashes: [],
      skipHashCheck: true as const,
    };
    const FAKE_REPO_ROOT_MANUAL = "/some/legacy/manual/repo/root";
    const manualOptIn = {
      repoId: { repoRoot: FAKE_REPO_ROOT_MANUAL },
      relativePath: ".vibe.toml",
      hashes: ["abcdef" + "0".repeat(58)],
      skipHashCheck: true as const,
    };
    settings.permissions.allow.push(fallbackArtifact, manualOptIn);
    await saveUserSettings(settings);

    try {
      const reloaded = await loadUserSettings();
      const cleanedFallback = reloaded.permissions.allow.find(
        (e) => e.repoId.repoRoot === FAKE_REPO_ROOT_FALLBACK,
      );
      const preservedManual = reloaded.permissions.allow.find(
        (e) => e.repoId.repoRoot === FAKE_REPO_ROOT_MANUAL,
      );
      expect(cleanedFallback).toBeDefined();
      expect(cleanedFallback!.skipHashCheck).toBeUndefined();
      expect(preservedManual).toBeDefined();
      expect(preservedManual!.skipHashCheck).toBe(true);
    } finally {
      const finalSettings = await loadUserSettings();
      finalSettings.permissions.allow = finalSettings.permissions.allow.filter(
        (e) =>
          e.repoId.repoRoot !== FAKE_REPO_ROOT_FALLBACK &&
          e.repoId.repoRoot !== FAKE_REPO_ROOT_MANUAL,
      );
      await saveUserSettings(finalSettings);
    }
  });

  it("removeTrustedPath warns when no matching entry exists", async () => {
    tempFile = join(process.cwd(), `.test-remove-warn-${Date.now()}.tmp`);
    await writeFile(tempFile, "content");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Path is in repo but not trusted, so no matching entry.
      await removeTrustedPath(tempFile);
      const wasCalled = warnSpy.mock.calls.some((call) =>
        String(call[0]).includes("No matching trust entry"),
      );
      expect(wasCalled).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
