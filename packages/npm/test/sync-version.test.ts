/**
 * Tests for scripts/sync-version.ts — the version-sync gate that
 * publish-npm's `verify-versions` job relies on (`sync-version --check`).
 *
 * What these guarantee:
 *   - a root version bump propagates to every JSON target (Cargo ×3, platform
 *     packages ×4, the inner npm package) AND to @kexi/vibe's exact
 *     optionalDependency pins (security D-2);
 *   - `--check` exits 1 on a drifted Cargo.toml, a missing expected target, and
 *     an unregistered `packages/vibe-*` dir;
 *   - the Cargo regex replaces ONLY the `[package] version` line, never a
 *     dependency `version = "..."` line (the fragile-regex regression guard).
 *
 * Everything runs against a throwaway fixture dir (runSync's `cwd` option) so
 * the real repo files are never mutated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runSync } from "../../../scripts/sync-version";

// The exact set of files sync-version expects (kept in step with the TARGETS /
// CARGO_TARGETS / PLATFORM_OPTIONAL_DEPS enumerations in the script under test).
const JSON_TARGETS = [
  "packages/npm/package.json",
  "packages/vibe-linux-x64/package.json",
  "packages/vibe-linux-arm64/package.json",
  "packages/vibe-darwin-x64/package.json",
  "packages/vibe-darwin-arm64/package.json",
];
const CARGO_TARGETS = [
  "rust/crates/vibe/Cargo.toml",
  "rust/crates/vibe-core/Cargo.toml",
  "rust/crates/vibe-test-support/Cargo.toml",
];
const PLATFORM_DEPS = [
  "@kexi/vibe-linux-x64",
  "@kexi/vibe-linux-arm64",
  "@kexi/vibe-darwin-x64",
  "@kexi/vibe-darwin-arm64",
];

let root: string;

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function writeJson(rel: string, data: unknown): void {
  write(rel, JSON.stringify(data, null, 2) + "\n");
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(root, rel), "utf-8")) as T;
}

function cargoToml(version: string): string {
  return `[package]
name = "vibe"
version = "${version}"
edition = "2021"
description = "Git worktree helper CLI"

[dependencies]
serde = { version = "1.0.0" }
clap = { version = "4.5.0" }
`;
}

/**
 * Build a complete in-sync fixture at `oldVersion`. Individual tests then bump
 * the root version or perturb a single file to exercise one failure mode.
 */
function buildFixture(oldVersion: string): void {
  writeJson("package.json", { name: "vibe-monorepo", version: oldVersion });

  for (const target of JSON_TARGETS) {
    if (target === "packages/npm/package.json") {
      const optionalDependencies = Object.fromEntries(PLATFORM_DEPS.map((d) => [d, oldVersion]));
      writeJson(target, { name: "@kexi/vibe", version: oldVersion, optionalDependencies });
    } else {
      writeJson(target, { name: target, version: oldVersion });
    }
  }
  for (const target of CARGO_TARGETS) {
    write(target, cargoToml(oldVersion));
  }
}

const silentLog = () => {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibe-sync-version-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runSync (write mode)", () => {
  it("propagates a version bump to all JSON targets, Cargo crates, and optionalDep pins", async () => {
    buildFixture("1.0.0");
    writeJson("package.json", { name: "vibe-monorepo", version: "2.0.0" });

    const result = await runSync({ cwd: root, checkOnly: false, log: silentLog });

    expect(result.exitCode).toBe(0);

    // All JSON targets carry the new top-level version.
    for (const target of JSON_TARGETS) {
      expect(readJson<{ version: string }>(target).version).toBe("2.0.0");
    }
    // All three Cargo crates' [package] version updated.
    for (const target of CARGO_TARGETS) {
      expect(readFileSync(join(root, target), "utf-8")).toContain('version = "2.0.0"');
    }
    // @kexi/vibe's four optionalDependency pins are bumped to the exact version.
    const npm = readJson<{ optionalDependencies: Record<string, string> }>(
      "packages/npm/package.json",
    );
    for (const dep of PLATFORM_DEPS) {
      expect(npm.optionalDependencies[dep]).toBe("2.0.0");
    }
  });

  it("rewrites ONLY the [package] version, never a dependency version line", async () => {
    buildFixture("1.0.0");
    writeJson("package.json", { name: "vibe-monorepo", version: "2.0.0" });

    await runSync({ cwd: root, checkOnly: false, log: silentLog });

    const toml = readFileSync(join(root, "rust/crates/vibe/Cargo.toml"), "utf-8");
    // The package version moved...
    expect(toml).toContain('version = "2.0.0"');
    // ...but the dependency version pins are untouched.
    expect(toml).toContain('serde = { version = "1.0.0" }');
    expect(toml).toContain('clap = { version = "4.5.0" }');
    // And the bump did not leak into the deps (no dep pinned to 2.0.0).
    expect(toml).not.toContain('version = "2.0.0" }');
  });
});

describe("runSync (--check gate)", () => {
  it("exits 0 when everything is already in sync", async () => {
    buildFixture("1.0.0");
    const result = await runSync({ cwd: root, checkOnly: true, log: silentLog });
    expect(result.exitCode).toBe(0);
  });

  it("exits 1 on a drifted Cargo.toml", async () => {
    buildFixture("1.0.0");
    // One crate stays behind at 0.9.0 while everything else is 1.0.0.
    write("rust/crates/vibe-core/Cargo.toml", cargoToml("0.9.0"));

    const result = await runSync({ cwd: root, checkOnly: true, log: silentLog });

    expect(result.exitCode).toBe(1);
    const drifted = result.results.find((r) => r.path === "rust/crates/vibe-core/Cargo.toml");
    expect(drifted?.status).toBe("updated"); // "would update" => mismatch in check mode
    // --check must not have written: the file is still at the drifted version.
    expect(readFileSync(join(root, "rust/crates/vibe-core/Cargo.toml"), "utf-8")).toContain(
      'version = "0.9.0"',
    );
  });

  it("exits 1 on a drifted optionalDependency pin even when top-level versions match", async () => {
    buildFixture("1.0.0");
    // Top-level versions all match, but one platform pin is stale.
    const npm = readJson<{
      version: string;
      optionalDependencies: Record<string, string>;
    }>("packages/npm/package.json");
    npm.optionalDependencies["@kexi/vibe-linux-x64"] = "0.9.0";
    writeJson("packages/npm/package.json", npm);

    const result = await runSync({ cwd: root, checkOnly: true, log: silentLog });

    expect(result.exitCode).toBe(1);
  });

  it("exits 1 when an expected target file is missing", async () => {
    buildFixture("1.0.0");
    rmSync(join(root, "packages/vibe-linux-x64/package.json"));

    const result = await runSync({ cwd: root, checkOnly: true, log: silentLog });

    expect(result.exitCode).toBe(1);
    const missing = result.results.find(
      (r) => r.path === "packages/vibe-linux-x64/package.json",
    );
    expect(missing?.status).toBe("not-found");
  });

  it("exits 1 on an unregistered packages/vibe-* dir", async () => {
    buildFixture("1.0.0");
    // A 5th platform package dir nobody wired into the script. The guard only
    // flags `vibe-*-(x64|arm64)` dirs, so the name must match that shape to be
    // a meaningful unregistered-platform regression (a freebsd target here).
    writeJson("packages/vibe-freebsd-x64/package.json", {
      name: "@kexi/vibe-freebsd-x64",
      version: "1.0.0",
    });

    const result = await runSync({ cwd: root, checkOnly: true, log: silentLog });

    expect(result.exitCode).toBe(1);
    expect(result.unregistered).toContain("vibe-freebsd-x64");
  });

  it("does not mutate any file in --check mode", async () => {
    buildFixture("1.0.0");
    writeJson("package.json", { name: "vibe-monorepo", version: "2.0.0" });
    const before = readFileSync(join(root, "rust/crates/vibe/Cargo.toml"), "utf-8");

    await runSync({ cwd: root, checkOnly: true, log: silentLog });

    expect(readFileSync(join(root, "rust/crates/vibe/Cargo.toml"), "utf-8")).toBe(before);
    // The drifted JSON target is likewise untouched.
    expect(readJson<{ version: string }>("packages/vibe-linux-x64/package.json").version).toBe(
      "1.0.0",
    );
    expect(existsSync(join(root, "package.json"))).toBe(true);
  });
});
