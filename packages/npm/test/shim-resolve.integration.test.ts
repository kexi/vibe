/**
 * Integration test for the @kexi/vibe shim's REAL resolution path.
 *
 * shim.test.ts unit-tests resolveBinary with MOCKED resolve/realpath. This test
 * exercises the un-mocked `require.resolve(@kexi/vibe-<plat>/bin/vibe, { paths:
 * [dirname] })` + real `fs.realpathSync` against a node_modules layout built on
 * disk, so a regression in the actual resolution / containment guard (the
 * security A-2 concern: the guard must accept an in-tree binary and reject an
 * out-of-tree one) is caught locally without the full CI install matrix.
 *
 * Scope (best-effort, per the QA note): it reproduces the plain-hoisted npm
 * layout (`node_modules/@kexi/vibe` + `node_modules/@kexi/vibe-<plat>`) and the
 * out-of-tree-symlink escape. The three-package-manager matrix (real npm/pnpm/
 * yarn installs) is covered by the CI install-matrix job, which is the only
 * place those layouts can be produced faithfully.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const require = createRequire(import.meta.url);
const shim = require("../bin/vibe.cjs");

// The host platform package name the shim would resolve. Derived from the real
// process so the test exercises whatever pair the runner actually is.
const hostPkg: string | null = shim.platformPackageName(process.platform, process.arch);

let root: string;

function writeFile(rel: string, content: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return abs;
}

/**
 * Lay down a plain (npm-hoisted) node_modules tree:
 *   node_modules/@kexi/vibe/            (the shim package — `dirname`)
 *   node_modules/@kexi/vibe-<plat>/     (the platform package, with bin/vibe)
 * Returns the shim dir (the `dirname` passed to resolveBinary).
 */
function buildHoistedLayout(pkg: string): { shimDir: string; binPath: string } {
  const nm = "node_modules";
  // The shim package itself.
  const shimDir = join(root, nm, "@kexi", "vibe");
  writeFile(join(nm, "@kexi", "vibe", "package.json"), JSON.stringify({ name: "@kexi/vibe" }));

  // The platform package: package.json must expose bin/vibe so require.resolve
  // of "<pkg>/bin/vibe" succeeds (resolution keys off package.json existence).
  writeFile(
    join(nm, pkg, "package.json"),
    JSON.stringify({ name: pkg, bin: { vibe: "bin/vibe" } }),
  );
  const binPath = writeFile(join(nm, pkg, "bin", "vibe"), "#!/bin/sh\necho fake\n");

  return { shimDir, binPath };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibe-shim-resolve-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveBinary (real require.resolve + realpath)", () => {
  it("resolves and accepts an in-tree platform binary (containment passes)", () => {
    // Skip on an unsupported host (e.g. a future Windows runner): there is no
    // platform package to resolve, so the in-tree case is not meaningful.
    if (hostPkg === null) return;

    const { shimDir, binPath } = buildHoistedLayout(hostPkg);

    const resolved = shim.resolveBinary({
      platform: process.platform,
      arch: process.arch,
      resolve: require.resolve,
      realpath: realpathSync,
      dirname: shimDir,
    });

    // realpathSync may canonicalize the temp root (e.g. /var -> /private/var on
    // macOS); compare against the realpath of the file we created.
    expect(resolved).toBe(realpathSync(binPath));
  });

  it("rejects a binary that realpaths OUTSIDE any node_modules tree (EOUTSIDE)", () => {
    if (hostPkg === null) return;

    const { shimDir } = buildHoistedLayout(hostPkg);

    // Replace the in-tree bin with a symlink pointing outside node_modules, so
    // require.resolve still succeeds (the symlink path is inside node_modules)
    // but realpathSync canonicalizes to an out-of-tree location.
    const outside = writeFile("outside/evil-vibe", "#!/bin/sh\necho evil\n");
    const linkPath = join(root, "node_modules", hostPkg, "bin", "vibe");
    rmSync(linkPath);
    symlinkSync(outside, linkPath);

    expect(() =>
      shim.resolveBinary({
        platform: process.platform,
        arch: process.arch,
        resolve: require.resolve,
        realpath: realpathSync,
        dirname: shimDir,
      }),
    ).toThrowError(/outside node_modules/);
  });

  it("throws ENORESOLVE when the platform package is absent", () => {
    if (hostPkg === null) return;

    // Only the shim package exists; no platform package was staged.
    const shimDir = join(root, "node_modules", "@kexi", "vibe");
    writeFile(
      join("node_modules", "@kexi", "vibe", "package.json"),
      JSON.stringify({ name: "@kexi/vibe" }),
    );

    try {
      shim.resolveBinary({
        platform: process.platform,
        arch: process.arch,
        resolve: require.resolve,
        realpath: realpathSync,
        dirname: shimDir,
      });
      expect.unreachable("should have thrown ENORESOLVE");
    } catch (err) {
      expect((err as { code: string }).code).toBe("ENORESOLVE");
    }
  });
});
