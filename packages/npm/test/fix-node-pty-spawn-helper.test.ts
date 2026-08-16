/**
 * What these guarantee for `scripts/fix-node-pty-spawn-helper.mjs`:
 *
 *   - node-pty is located by node's own resolution from the e2e package, so a
 *     copy HOISTED to the workspace root is found (the exact layout
 *     `node-linker=hoisted` + `public-hoist-pattern[]=*node-pty*` produces, and
 *     the one the old relative glob missed — issue #618);
 *   - an install with no node-pty at all resolves to null rather than throwing,
 *     so `--ignore-scripts`/filtered installs stay quiet;
 *   - every `prebuilds/<platform>/spawn-helper` is collected, in stable order,
 *     while prebuild directories that legitimately have no helper (win32) and a
 *     missing `prebuilds/` are tolerated;
 *   - a from-source build, where node-pty deletes `prebuilds/` and emits
 *     `build/Release/spawn-helper` (or `build/Debug/spawn-helper`, which
 *     node-pty's own loader also accepts), is still found — so the loud failure
 *     fires only when NO layout has a helper, never on a healthy tree;
 *   - "no helper at all" is only fatal on macOS: node-pty's binding.gyp builds
 *     the spawn-helper target under `['OS=="mac"']` only, and `pty.cc` reads
 *     helperPath solely under `#if defined(__APPLE__)`, so a Linux tree with no
 *     helper is healthy and must not fail `pnpm install`;
 *   - the executable-bit predicate only accepts a mode with all three execute
 *     bits set, which is what makes the chmod idempotent.
 *
 * The resolution and directory cases build throwaway node_modules trees under
 * the OS temp dir; the mode predicate is driven directly with literals.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  statSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveNodePtyDir,
  findSpawnHelpers,
  isExecutable,
  helperIsRequired,
  EXECUTABLE_MODE,
} from "../../../scripts/fix-node-pty-spawn-helper.mjs";

let root: string;

/** Create a minimal node-pty install at <root>/<prefix>/node_modules/node-pty. */
function installNodePty(prefix: string, platforms: string[]): string {
  const dir = join(root, prefix, "node_modules", "node-pty");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0" }));
  for (const platform of platforms) {
    const prebuild = join(dir, "prebuilds", platform);
    mkdirSync(prebuild, { recursive: true });
    writeFileSync(join(prebuild, "spawn-helper"), "#!/bin/sh\n");
    chmodSync(join(prebuild, "spawn-helper"), 0o644);
  }
  return dir;
}

/** Add the `build/<config>/spawn-helper` a local node-gyp build leaves behind. */
function addBuiltHelper(dir: string, mode = 0o755, config = "Release"): string {
  const output = join(dir, "build", config);
  mkdirSync(output, { recursive: true });
  const helper = join(output, "spawn-helper");
  writeFileSync(helper, "#!/bin/sh\n");
  chmodSync(helper, mode);
  return helper;
}

beforeEach(() => {
  // realpath: on macOS tmpdir() is /var/... which is a symlink to /private/var,
  // and node's resolver returns the canonical path — so the fixture must too.
  root = realpathSync(mkdtempSync(join(tmpdir(), "vibe-spawn-helper-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveNodePtyDir", () => {
  it("finds node-pty hoisted to the workspace root from a nested package", () => {
    const hoisted = installNodePty(".", ["darwin-arm64"]);
    const pkg = join(root, "packages", "e2e");
    mkdirSync(pkg, { recursive: true });

    expect(resolveNodePtyDir(pkg)).toBe(hoisted);
  });

  it("prefers a package-local node-pty over the hoisted one", () => {
    installNodePty(".", ["darwin-arm64"]);
    const local = installNodePty(join("packages", "e2e"), ["darwin-arm64"]);

    expect(resolveNodePtyDir(join(root, "packages", "e2e"))).toBe(local);
  });

  it("returns null when node-pty is not installed anywhere", () => {
    const pkg = join(root, "packages", "e2e");
    mkdirSync(pkg, { recursive: true });

    expect(resolveNodePtyDir(pkg)).toBeNull();
  });

  // NOTE: the only chdir in this package's tests. It mutates global process
  // state, so this file must stay sequential — do not add describe.concurrent
  // or test.concurrent here without first removing the chdir.
  it("accepts a relative directory", () => {
    const hoisted = installNodePty(".", ["linux-x64"]);
    const previous = process.cwd();
    process.chdir(root);
    try {
      expect(resolveNodePtyDir(".")).toBe(hoisted);
    } finally {
      process.chdir(previous);
    }
  });
});

describe("findSpawnHelpers", () => {
  it("collects every prebuilt spawn-helper in stable order", () => {
    const dir = installNodePty(".", ["darwin-x64", "darwin-arm64", "linux-x64"]);

    expect(findSpawnHelpers(dir)).toEqual([
      join(dir, "prebuilds", "darwin-arm64", "spawn-helper"),
      join(dir, "prebuilds", "darwin-x64", "spawn-helper"),
      join(dir, "prebuilds", "linux-x64", "spawn-helper"),
    ]);
  });

  it("skips a prebuild directory that has no spawn-helper", () => {
    const dir = installNodePty(".", ["darwin-arm64"]);
    mkdirSync(join(dir, "prebuilds", "win32-x64"), { recursive: true });

    expect(findSpawnHelpers(dir)).toEqual([
      join(dir, "prebuilds", "darwin-arm64", "spawn-helper"),
    ]);
  });

  it("finds the from-source helper when prebuilds/ was deleted by the build", () => {
    // npm_config_build_from_source=true makes node-pty rm -rf prebuilds/ and
    // compile to build/Release instead; that tree is healthy, not a miss.
    const dir = installNodePty(".", []);
    const built = addBuiltHelper(dir);

    expect(findSpawnHelpers(dir)).toEqual([built]);
  });

  it("collects the from-source helper alongside the prebuilt ones", () => {
    const dir = installNodePty(".", ["darwin-arm64"]);
    const built = addBuiltHelper(dir);

    expect(findSpawnHelpers(dir)).toEqual([
      join(dir, "prebuilds", "darwin-arm64", "spawn-helper"),
      built,
    ]);
  });

  it("returns a non-executable from-source helper so it gets chmodded", () => {
    const dir = installNodePty(".", []);
    const built = addBuiltHelper(dir, 0o644);

    expect(findSpawnHelpers(dir)).toEqual([built]);
    expect(isExecutable(statSync(built).mode)).toBe(false);
  });

  it("finds a Debug-configuration helper, which node-pty's loader also accepts", () => {
    // loadNativeModule() searches build/Release, then build/Debug, then
    // prebuilds/ — so a Debug-only tree is loadable and must not be a miss.
    const dir = installNodePty(".", []);
    const debug = addBuiltHelper(dir, 0o755, "Debug");

    expect(findSpawnHelpers(dir)).toEqual([debug]);
  });

  it("reports an empty list when no layout has a helper", () => {
    const dir = installNodePty(".", []);

    expect(findSpawnHelpers(dir)).toEqual([]);
  });

  it("reports an empty list for the tree a Linux from-source build leaves", () => {
    // On Linux node-pty ships no prebuilds/linux-*, so it always compiles from
    // source, and binding.gyp emits pty.node WITHOUT a spawn-helper target.
    // This exact tree is healthy — see the helperIsRequired suite.
    const dir = installNodePty(".", []);
    mkdirSync(join(dir, "build", "Release"), { recursive: true });
    writeFileSync(join(dir, "build", "Release", "pty.node"), "");

    expect(findSpawnHelpers(dir)).toEqual([]);
  });
});

describe("helperIsRequired", () => {
  it("treats a missing helper as fatal only on macOS", () => {
    expect(helperIsRequired("darwin")).toBe(true);
  });

  it("tolerates a missing helper on linux, where node-pty never builds one", () => {
    // Regression guard: exiting non-zero here would break `pnpm install` on
    // every Linux dev machine and in Docker, on a perfectly healthy tree.
    expect(helperIsRequired("linux")).toBe(false);
  });

  it("tolerates a missing helper on win32, which uses ConPTY/winpty", () => {
    expect(helperIsRequired("win32")).toBe(false);
  });
});

describe("isExecutable", () => {
  it("rejects the mode node-pty's tarball ships (0644) and accepts 0755", () => {
    expect(isExecutable(0o644)).toBe(false);
    expect(isExecutable(EXECUTABLE_MODE)).toBe(true);
  });

  it("rejects a mode with only some execute bits set", () => {
    expect(isExecutable(0o744)).toBe(false);
    expect(isExecutable(0o754)).toBe(false);
  });

  it("reads true for a file chmodded to EXECUTABLE_MODE", () => {
    const dir = installNodePty(".", ["darwin-arm64"]);
    const helper = join(dir, "prebuilds", "darwin-arm64", "spawn-helper");

    expect(isExecutable(statSync(helper).mode)).toBe(false);
    chmodSync(helper, EXECUTABLE_MODE);
    expect(isExecutable(statSync(helper).mode)).toBe(true);
  });
});
