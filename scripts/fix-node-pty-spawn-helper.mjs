#!/usr/bin/env node

/**
 * Restore the execute bit on node-pty's `spawn-helper` binaries.
 *
 * node-pty's npm tarball ships `prebuilds/<platform>/spawn-helper` without the
 * execute bit; on macOS the addon `posix_spawn`s that path for every PTY it
 * opens, so without +x the whole E2E harness dies with "posix_spawnp failed".
 *
 * Why macOS only: `spawn-helper` is emitted by a `binding.gyp` target guarded by
 * `['OS=="mac"']`, and `src/unix/pty.cc` only reads the `helperPath` argument
 * inside `#if defined(__APPLE__)` — every other Unix forks and `execvp`s
 * directly. So on Linux a perfectly healthy node-pty has NO spawn-helper
 * anywhere, and treating that as a failure would break `pnpm install` outright.
 *
 * Why several layouts are searched: a from-source build (CI's e2e job sets
 * `npm_config_build_from_source=true`) makes node-pty delete `prebuilds/` and
 * emit `build/<config>/spawn-helper` instead. Looking only under `prebuilds/`
 * would report that healthy tree as the #618 failure.
 *
 * Why resolution rather than a fixed relative path: the repo sets
 * `node-linker=hoisted` with `public-hoist-pattern[]=*node-pty*`, so node-pty
 * installs into the WORKSPACE ROOT `node_modules`, not
 * `packages/e2e/node_modules`. The previous one-liner globbed
 * `node_modules/node-pty/prebuilds/<any>/spawn-helper` relative to the e2e
 * package, so it matched nothing and its `|| true` hid the miss (issue #618).
 * `require.resolve` follows the same lookup node itself will use at test time,
 * so it tracks the layout instead of guessing at it.
 *
 * Why this fails loudly (on macOS): a silent miss is exactly how #618 survived —
 * the install looked clean and only the E2E suite, much later, reported an
 * unrelated-looking spawn error. The failure is judged on the ONE helper
 * node-pty will really exec (see activeSpawnHelper), because a helper belonging
 * to another arch or build config is never run and would otherwise mask a miss.
 *
 * Why plain node and not bun, and why `.mjs` and not `.ts`: this runs from
 * `packages/e2e`'s postinstall, i.e. during `pnpm install`, before any dev shell
 * is necessarily present. bun is a dev-shell tool, so requiring it here would
 * make a plain `pnpm install` fail with `bun: command not found`. node is
 * guaranteed by `engines.node` (>=18), but type stripping is not available that
 * far back — hence JSDoc types rather than TypeScript syntax.
 *
 * Usage:
 *   node scripts/fix-node-pty-spawn-helper.mjs [package-dir]
 *
 * `package-dir` (default: cwd) is the package whose resolution context is used;
 * packages/e2e's postinstall passes `.` so the lookup starts there.
 */

import { chmodSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Directory under a node-pty install that holds the per-platform prebuilds. */
const PREBUILDS_DIR = "prebuilds";
/**
 * Where node-gyp drops the helper when node-pty is compiled locally. node-pty's
 * `scripts/prebuild.js` DELETES `prebuilds/` outright when
 * `npm_config_build_from_source=true` (which is exactly what CI's e2e job does),
 * so on such a tree these are the only spawn-helpers that exist.
 *
 * Both configurations are probed because node-pty's own `loadNativeModule()`
 * searches `build/Release`, then `build/Debug`, then `prebuilds/` — a Debug
 * build is a tree it will happily load, so it must not be reported as a miss.
 */
const BUILD_OUTPUT_DIRS = [join("build", "Release"), join("build", "Debug")];
const HELPER_NAME = "spawn-helper";
/** The addon node-pty loads; its directory is the one whose helper is used. */
const ADDON_NAME = "pty.node";

/** rwxr-xr-x — the mode node-pty's own build emits for spawn-helper. */
export const EXECUTABLE_MODE = 0o755;

/**
 * Resolve the directory of the node-pty install that `from` would load,
 * following the same algorithm node uses at runtime. Returns null when node-pty
 * is not installed (a `--filter`ed or `--ignore-scripts` install), which is not
 * an error: there is nothing to repair.
 *
 * @param {string} from
 * @returns {string | null}
 */
export function resolveNodePtyDir(from) {
  // createRequire needs an absolute path to a (notional) file inside `from`;
  // the file itself never has to exist, only anchor the lookup.
  const require_ = createRequire(join(resolve(from), "noop.js"));
  try {
    return dirname(require_.resolve("node-pty/package.json"));
  } catch {
    return null;
  }
}

/**
 * True when `candidate` exists and is a regular file.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * List every `spawn-helper` present under a node-pty install: the shipped
 * `prebuilds/<platform>/spawn-helper` binaries plus the locally compiled
 * `build/Release/spawn-helper` and `build/Debug/spawn-helper`.
 *
 * All locations are searched because they are mutually exclusive in practice —
 * a from-source build removes `prebuilds/` (see BUILD_OUTPUT_DIRS) — so keying
 * off only one makes a healthy tree look broken. An empty list is returned
 * rather than throwing when none exists, so the caller decides whether
 * emptiness is fatal (off macOS it never is; see main()).
 *
 * @param {string} nodePtyDir
 * @returns {string[]}
 */
export function findSpawnHelpers(nodePtyDir) {
  /** @type {string[]} */
  const helpers = [];

  const prebuilds = join(nodePtyDir, PREBUILDS_DIR);
  /** @type {string[]} */
  let entries = [];
  try {
    entries = readdirSync(prebuilds);
  } catch {
    // No prebuilds/ at all: a from-source build, handled by the probe below.
  }
  for (const entry of entries.sort()) {
    const candidate = join(prebuilds, entry, HELPER_NAME);
    // A prebuilds/ subdirectory without a spawn-helper (e.g. win32) is normal.
    if (isFile(candidate)) {
      helpers.push(candidate);
    }
  }

  for (const outputDir of BUILD_OUTPUT_DIRS) {
    const built = join(nodePtyDir, outputDir, HELPER_NAME);
    if (isFile(built)) {
      helpers.push(built);
    }
  }

  return helpers;
}

/**
 * The `spawn-helper` node-pty will actually execute at runtime, or null if the
 * addon itself cannot be located.
 *
 * node-pty does NOT search for the helper independently: `loadNativeModule()`
 * picks the first directory (build/Release, then build/Debug, then
 * `prebuilds/<platform>-<arch>`) that contains a loadable `pty.node`, and
 * `unixTerminal.js` then derives `helperPath` as `<that same dir>/spawn-helper`.
 * So a helper sitting in any OTHER directory — a different arch's prebuild, or
 * a build config that is not the one being loaded — is never executed and
 * cannot substitute for a missing one. Checking only that SOME helper exists
 * would therefore still let the #618 symptom through.
 *
 * `canLoad` decides a candidate the way node-pty does: by actually requiring the
 * addon and falling through on failure, NOT by mere file existence. A stale
 * `build/Release/pty.node` left over from a different arch or a failed compile
 * still exists as a file but throws on dlopen, so node-pty skips past it to the
 * prebuild — and a check based on existence alone would pin the verdict to the
 * wrong directory, in either direction. Requiring the addon is safe here:
 * dlopen failures surface as ordinary catchable Errors, verified against both a
 * corrupt file and a genuine wrong-arch pty.node.
 *
 * @param {string} nodePtyDir
 * @param {string} platform
 * @param {string} arch
 * @param {(addonPath: string) => boolean} [canLoad]
 * @returns {string | null}
 */
export function activeSpawnHelper(nodePtyDir, platform, arch, canLoad = isLoadableAddon) {
  const searchOrder = [...BUILD_OUTPUT_DIRS, join(PREBUILDS_DIR, `${platform}-${arch}`)];
  for (const dir of searchOrder) {
    const addon = join(nodePtyDir, dir, ADDON_NAME);
    if (isFile(addon) && canLoad(addon)) {
      return join(nodePtyDir, dir, HELPER_NAME);
    }
  }
  return null;
}

/**
 * True when `addonPath` is a native addon this process can actually dlopen —
 * the same test node-pty's loader applies by `require()`ing each candidate.
 *
 * @param {string} addonPath
 * @returns {boolean}
 */
function isLoadableAddon(addonPath) {
  try {
    createRequire(addonPath)(addonPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when every execute bit (user/group/other) is already set.
 *
 * @param {number} mode
 * @returns {boolean}
 */
export function isExecutable(mode) {
  return (mode & 0o111) === 0o111;
}

/**
 * True on the one platform where a missing `spawn-helper` is a real defect.
 *
 * node-pty only builds and only uses spawn-helper on macOS (binding.gyp's
 * `['OS=="mac"']` target; `helperPath` is read solely under
 * `#if defined(__APPLE__)` in src/unix/pty.cc). On Linux the tarball ships no
 * `prebuilds/linux-*` at all, so node-pty always compiles from source and
 * legitimately produces no helper; on Windows it uses ConPTY/winpty. Treating
 * those as the #618 symptom would fail `pnpm install` on a healthy tree.
 *
 * @param {string} platform
 * @returns {boolean}
 */
export function helperIsRequired(platform) {
  return platform === "darwin";
}

function main() {
  const packageDir = process.argv[2] ?? process.cwd();

  const nodePtyDir = resolveNodePtyDir(packageDir);
  if (nodePtyDir === null) {
    console.log("fix-node-pty-spawn-helper: node-pty is not installed, nothing to do.");
    return;
  }

  // Repair every helper present, not just the active one: chmodding a helper
  // for another arch or build config is harmless and keeps the tree correct
  // across a later arch switch or Release/Debug rebuild.
  const helpers = findSpawnHelpers(nodePtyDir);

  // But only the helper node-pty will actually exec decides pass/fail — see
  // activeSpawnHelper(). A helper elsewhere in the tree is never run, so
  // counting those would let the #618 symptom through.
  if (helperIsRequired(process.platform)) {
    const active = activeSpawnHelper(nodePtyDir, process.platform, process.arch);
    if (active === null || !isFile(active)) {
      console.error(
        `fix-node-pty-spawn-helper: node-pty resolved to ${nodePtyDir} but the ` +
          `${HELPER_NAME} it will load on ${process.platform}-${process.arch} ` +
          `(${active ?? "no " + ADDON_NAME + " found at all"}) is missing. The E2E ` +
          `suite will fail with "posix_spawnp failed" — check the node-pty layout.`,
      );
      process.exit(1);
    }
  } else if (helpers.length === 0) {
    console.log(
      `fix-node-pty-spawn-helper: no ${HELPER_NAME} on ${process.platform} ` +
        `(node-pty only builds one on macOS), nothing to do.`,
    );
    return;
  }

  for (const helper of helpers) {
    if (isExecutable(statSync(helper).mode)) {
      console.log(`fix-node-pty-spawn-helper: already executable ${helper}`);
      continue;
    }
    chmodSync(helper, EXECUTABLE_MODE);
    console.log(`fix-node-pty-spawn-helper: chmod +x ${helper}`);
  }
}

// `import.meta.main` is bun/Node-24-only; comparing the resolved argv[1] is the
// portable "am I the entrypoint" test, and keeps the module importable by the
// tests without running main().
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
