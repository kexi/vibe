#!/usr/bin/env node
"use strict";

/**
 * @kexi/vibe launcher shim (CommonJS).
 *
 * The shipped vibe is a native Rust binary. npm cannot put a per-platform
 * binary directly in @kexi/vibe, so this package declares four
 * `optionalDependencies` (one per platform/arch); npm/pnpm/yarn install only
 * the one matching the host (via each platform package's `os`/`cpu` fields).
 * This shim resolves that platform package's `bin/vibe` and execs it.
 *
 * HOW (the security-reviewed launch sequence — see SECURITY notes inline):
 *   1. Compute the platform package name from process.platform/arch.
 *   2. require.resolve it with `paths: [__dirname]` so resolution is pinned to
 *      THIS package's dependency tree (not some unrelated @kexi/vibe-* on a
 *      wider NODE_PATH).
 *   3. Defense-in-depth containment check on the realpath'd binary.
 *   4. chmod +x only if it is not already executable.
 *   5. spawnSync with stdio inherited, NO shell, and faithfully propagate the
 *      child's exit status / signal.
 *
 * SECURITY — DO NOT WEAKEN (two deliberate supply-chain decisions):
 *
 *   (D-2) The four `@kexi/vibe-<platform>-<arch>` optionalDependencies in
 *   package.json are pinned to EXACT versions (e.g. "1.8.1"), never ranges
 *   ("^1.8.1"). This guarantees the launcher only ever resolves the binary
 *   built and published from THIS exact release — a range would let a later
 *   (possibly compromised or unvetted) platform-package version be substituted
 *   under a user who only audited @kexi/vibe. scripts/sync-version.ts keeps
 *   these pins equal to the root version; do not relax them to ranges.
 *
 *   (no-fallback) When the platform package cannot be resolved (resolveBinary
 *   throws ENORESOLVE), this shim ERRORS OUT and tells the user to reinstall.
 *   There is intentionally NO postinstall step and NO network fetch fallback:
 *   the binary only ever arrives through npm's normal, integrity-checked
 *   optionalDependency install. A "convenience" download-on-failure would
 *   fetch an unverified binary outside npm's integrity guarantees — do not add
 *   one (no postinstall script, no curl/https.get fallback here).
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * Map a Node `process.platform`/`process.arch` pair to the scoped platform
 * package name. Returns null for unsupported pairs so the caller can emit a
 * clear error rather than resolving a nonexistent package.
 */
function platformPackageName(platform, arch) {
  const SUPPORTED = {
    "linux-x64": "@kexi/vibe-linux-x64",
    "linux-arm64": "@kexi/vibe-linux-arm64",
    "darwin-x64": "@kexi/vibe-darwin-x64",
    "darwin-arm64": "@kexi/vibe-darwin-arm64",
  };
  const key = `${platform}-${arch}`;
  return SUPPORTED[key] ?? null;
}

/**
 * Defense-in-depth containment check for the resolved binary path.
 *
 * Resolution is already pinned via `require.resolve(..., { paths: [__dirname] })`,
 * which is the primary guard. This is a secondary check that the realpath'd
 * binary lives inside SOME `node_modules` tree, catching a binary that resolved
 * to an unexpected location outside the dependency graph.
 *
 * Why not `startsWith(@kexi/vibe's own dir)` (security A-2): pnpm installs into
 * a `.pnpm` symlink farm, so after realpath the platform binary is physically
 * under `.../node_modules/.pnpm/@kexi+vibe-...@x/node_modules/@kexi/...`, NOT
 * under @kexi/vibe's own directory. Over-tightening here breaks pnpm. The robust
 * invariant that holds across npm/pnpm/yarn-classic is "the realpath has a
 * `node_modules` path segment". `path.relative` (not `startsWith`) is used for
 * the segment check to avoid prefix-collision false positives.
 */
function isWithinNodeModules(realBinaryPath) {
  const segments = realBinaryPath.split(path.sep);
  const nmIndex = segments.indexOf("node_modules");
  if (nmIndex === -1) {
    return false;
  }
  // Reconstruct the node_modules root and verify the binary is genuinely below
  // it via path.relative: the relative path must not escape upward (`..`) and
  // must not be absolute (different root/drive on Windows).
  //
  // `|| path.sep`: the only way the join is empty is nmIndex === 0, i.e.
  // "node_modules" is the very first segment. realpath() always returns an
  // absolute path (segment 0 is "" on POSIX from the leading "/", or a drive on
  // Windows), so in production nmIndex is never 0 and this fallback is not hit.
  // It is kept as a defensive guard so a hypothetical relative input still
  // yields a usable root ("/") instead of an empty string that would make
  // path.relative misbehave.
  const nmRoot = segments.slice(0, nmIndex + 1).join(path.sep) || path.sep;
  const rel = path.relative(nmRoot, realBinaryPath);
  const escapes = rel === "" || rel.startsWith("..") || path.isAbsolute(rel);
  return !escapes;
}

/**
 * Resolve the platform binary path, applying the pinned resolution and the
 * containment check. Throws an Error with a `.code` of "EUNSUPPORTED",
 * "ENORESOLVE", or "EOUTSIDE" so the CLI layer can format a clear message.
 *
 * Dependencies are injected (resolve / realpath / platform / arch / dirname) so
 * the logic is unit-testable without a real binary on disk.
 */
function resolveBinary({ platform, arch, resolve, realpath, dirname }) {
  const pkg = platformPackageName(platform, arch);
  if (pkg === null) {
    const err = new Error(`unsupported platform/arch: ${platform}/${arch}`);
    err.code = "EUNSUPPORTED";
    throw err;
  }

  let resolved;
  try {
    resolved = resolve(`${pkg}/bin/vibe`, { paths: [dirname] });
  } catch {
    const err = new Error(
      `platform package ${pkg} not installed for ${platform}/${arch}; ` +
        `reinstall vibe (do not pass --no-optional)`,
    );
    err.code = "ENORESOLVE";
    err.pkg = pkg;
    throw err;
  }

  const real = realpath(resolved);
  if (!isWithinNodeModules(real)) {
    const err = new Error(
      `refusing to run ${pkg} binary outside node_modules: ${real}`,
    );
    err.code = "EOUTSIDE";
    throw err;
  }

  return real;
}

/**
 * Ensure the binary is executable on POSIX. chmod is attempted ONLY when the
 * X_OK access check fails, so a read-only/immutable store (Nix, pnpm
 * content-addressed store) is not needlessly written to.
 */
function ensureExecutable(binaryPath, { platform, accessSync, chmodSync, constants }) {
  if (platform === "win32") {
    return;
  }
  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    chmodSync(binaryPath, 0o755);
  }
}

/**
 * Full launch sequence. Returns the numeric exit code the process should use,
 * or performs a signal re-raise. Side effects (spawn, exit) are injected so the
 * orchestration can be exercised in tests.
 */
function run({
  argv,
  platform,
  arch,
  resolve,
  realpath,
  dirname,
  accessSync,
  chmodSync,
  constants,
  spawn,
  stderr,
  killProcess,
}) {
  let binaryPath;
  try {
    binaryPath = resolveBinary({ platform, arch, resolve, realpath, dirname });
  } catch (err) {
    stderr(`vibe: ${err.message}\n`);
    return 1;
  }

  ensureExecutable(binaryPath, { platform, accessSync, chmodSync, constants });

  const result = spawn(binaryPath, argv, { stdio: "inherit" });

  if (result.error) {
    stderr(`vibe: failed to launch binary: ${result.error.message}\n`);
    return 1;
  }
  if (result.signal) {
    // Re-raise the same signal so the parent's exit reflects the child's death
    // (e.g. SIGINT from Ctrl-C) instead of a synthetic exit code.
    killProcess(result.signal);
    return 1; // Unreached if the signal terminates us; a fallback otherwise.
  }
  return result.status ?? 1;
}

module.exports = {
  platformPackageName,
  isWithinNodeModules,
  resolveBinary,
  ensureExecutable,
  run,
};

// Executed directly (the `bin` entry): wire up the real Node primitives.
if (require.main === module) {
  const code = run({
    argv: process.argv.slice(2),
    platform: process.platform,
    arch: process.arch,
    resolve: require.resolve,
    realpath: fs.realpathSync,
    dirname: __dirname,
    accessSync: fs.accessSync,
    chmodSync: fs.chmodSync,
    constants: fs.constants,
    spawn: spawnSync,
    stderr: (msg) => process.stderr.write(msg),
    killProcess: (signal) => process.kill(process.pid, signal),
  });
  process.exit(code);
}
