/**
 * Registration guards for the bmp-owned release-version machinery (.bmp.yml).
 *
 * These replace scripts/sync-version.ts's `--check`-era STRUCTURAL guards now
 * that bmp (kt3k/bmp, driven by .bmp.yml) owns value synchronization:
 *
 *   - bmp validates VALUES: `pnpm run bmp` (no args) substitutes .bmp.yml's
 *     `version:` into every configured pattern and exits 1 if any target file
 *     does not contain it (including a missing file). That runs in CI's
 *     publish-npm verify-versions job.
 *   - this test validates REGISTRATION: nothing on disk escapes .bmp.yml (an
 *     unregistered `packages/vibe-*` platform dir, a platform whose manifest or
 *     optionalDependency pin or lockfile specifier is not wired into .bmp.yml).
 *     bmp cannot detect a file it was never told about — that is the exact hole
 *     sync-version.ts's findUnregisteredPlatformDirs() covered.
 *
 * Plus a cheap, dependency-free text-level version-coherence check so drift
 * between .bmp.yml and the committed manifests fails in PR CI (the normal test
 * suite), not only at release time.
 *
 * Reads the REAL repo files (resolved from the repo root, three levels up from
 * this test dir): these assert the committed configuration, not a fixture.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Repo root: packages/npm/test -> ../../..
const REPO_ROOT = join(__dirname, "..", "..", "..");

const PLATFORMS = [
  "vibe-linux-x64",
  "vibe-linux-arm64",
  "vibe-darwin-x64",
  "vibe-darwin-arm64",
  "vibe-win32-x64",
];

function readRepoFile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

function readRepoJson<T>(rel: string): T {
  return JSON.parse(readRepoFile(rel)) as T;
}

const bmpYml = readRepoFile(".bmp.yml");

describe(".bmp.yml platform manifest registration", () => {
  it("registers a package.json target for every platform", () => {
    for (const p of PLATFORMS) {
      expect(bmpYml).toContain(`packages/${p}/package.json:`);
    }
  });

  it("registers the optionalDependency pin pattern for every platform", () => {
    for (const p of PLATFORMS) {
      expect(bmpYml).toContain(`"@kexi/${p}": "%.%.%"`);
    }
  });

  it("registers the pnpm-lock.yaml importer specifier pattern for every platform", () => {
    // .bmp.yml stores each lockfile pattern as a double-quoted YAML scalar using
    // the `\n` escape (see the file). bmp YAML-decodes that escape into a real
    // newline so the pattern spans the importer's package-name line and its
    // 8-space-indented `specifier:` line. This test reads the RAW file bytes
    // (zero-dependency: no YAML parser), where the escape is the two literal
    // characters backslash + 'n' — hence `\\n` below, matching the file on disk.
    for (const p of PLATFORMS) {
      expect(bmpYml).toContain(`'@kexi/${p}':\\n        specifier: %.%.%`);
    }
  });
});

describe("packages/npm optionalDependencies", () => {
  it("declares exactly the supported platform packages", () => {
    const npm = readRepoJson<{ optionalDependencies: Record<string, string> }>(
      "packages/npm/package.json",
    );
    const declared = Object.keys(npm.optionalDependencies).sort();
    const expected = PLATFORMS.map((p) => `@kexi/${p}`).sort();
    expect(declared).toEqual(expected);
  });
});

describe("unregistered platform dir guard", () => {
  it("has no packages/vibe-*-(x64|arm64) dir missing from PLATFORMS or .bmp.yml", () => {
    const entries = readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true });
    const platformDirs = entries
      .filter((e) => e.isDirectory() && /^vibe-.*-(x64|arm64)$/.test(e.name))
      .map((e) => e.name);

    for (const name of platformDirs) {
      // Every platform dir on disk must be a known platform...
      expect(PLATFORMS).toContain(name);
      // ...and be registered as a bmp target so its version stays synced.
      expect(bmpYml).toContain(`packages/${name}/package.json:`);
    }
  });
});

describe(".bmp.yml non-platform target registration", () => {
  it("registers the root package.json and the three Rust crates, but not vibe-native", () => {
    // Root package.json is registered as its own `files:` key (indented under
    // `files:`), distinct from the `packages/.../package.json:` entries — the
    // `\.` after `package` rules out the `packages/...` lines.
    expect(bmpYml).toMatch(/^\s*package\.json:/m);
    expect(bmpYml).toContain("rust/crates/vibe/Cargo.toml:");
    expect(bmpYml).toContain("rust/crates/vibe-core/Cargo.toml:");
    expect(bmpYml).toContain("rust/crates/vibe-test-support/Cargo.toml:");
    // vibe-native carries an independent version and must NOT be synced.
    expect(bmpYml).not.toContain("rust/crates/vibe-native");
  });
});

describe("version coherence (drift visible in PR CI)", () => {
  it("the .bmp.yml version equals every committed manifest version and pin", () => {
    const match = bmpYml.match(/^version:\s*(\S+)$/m);
    expect(match).not.toBeNull();
    const version = match![1];

    // Root + inner npm package + every platform package.
    expect(readRepoJson<{ version: string }>("package.json").version).toBe(version);
    expect(readRepoJson<{ version: string }>("packages/npm/package.json").version).toBe(version);
    for (const p of PLATFORMS) {
      expect(readRepoJson<{ version: string }>(`packages/${p}/package.json`).version).toBe(version);
    }

    // Every @kexi/vibe optionalDependency pin (security D-2: exact, not a range).
    const npm = readRepoJson<{ optionalDependencies: Record<string, string> }>(
      "packages/npm/package.json",
    );
    for (const p of PLATFORMS) {
      expect(npm.optionalDependencies[`@kexi/${p}`]).toBe(version);
    }
  });
});
