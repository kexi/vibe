#!/usr/bin/env bun

/**
 * Restore the execute bit on node-pty's prebuilt `spawn-helper` binaries.
 *
 * node-pty's npm tarball ships `prebuilds/<platform>/spawn-helper` without the
 * execute bit; on POSIX the addon `posix_spawnp`s that path for every PTY it
 * opens, so without +x the whole E2E harness dies with "posix_spawnp failed".
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
 * Why this fails loudly: a silent miss is exactly how #618 survived — the
 * install looked clean and only the E2E suite, much later, reported an
 * unrelated-looking spawn error.
 *
 * Usage:
 *   bun run scripts/fix-node-pty-spawn-helper.ts [package-dir]
 *
 * `package-dir` (default: cwd) is the package whose resolution context is used;
 * packages/e2e's postinstall passes `.` so the lookup starts there.
 */

import { chmodSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/** Directory under a node-pty install that holds the per-platform prebuilds. */
const PREBUILDS_DIR = "prebuilds";
const HELPER_NAME = "spawn-helper";

/** rwxr-xr-x — the mode node-pty's own build emits for spawn-helper. */
export const EXECUTABLE_MODE = 0o755;

/**
 * Resolve the directory of the node-pty install that `from` would load,
 * following the same algorithm node uses at runtime. Returns null when node-pty
 * is not installed (a `--filter`ed or `--ignore-scripts` install), which is not
 * an error: there is nothing to repair.
 */
export function resolveNodePtyDir(from: string): string | null {
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
 * List the `prebuilds/<platform>/spawn-helper` files present under a node-pty
 * install. Missing `prebuilds/` yields an empty list rather than throwing, so
 * the caller decides whether emptiness is fatal.
 */
export function findSpawnHelpers(nodePtyDir: string): string[] {
  const prebuilds = join(nodePtyDir, PREBUILDS_DIR);
  let entries: string[];
  try {
    entries = readdirSync(prebuilds);
  } catch {
    return [];
  }

  const helpers: string[] = [];
  for (const entry of entries.sort()) {
    const candidate = join(prebuilds, entry, HELPER_NAME);
    try {
      if (statSync(candidate).isFile()) {
        helpers.push(candidate);
      }
    } catch {
      // A prebuilds/ subdirectory without a spawn-helper (e.g. win32) is normal.
    }
  }
  return helpers;
}

/** True when every execute bit (user/group/other) is already set. */
export function isExecutable(mode: number): boolean {
  return (mode & 0o111) === 0o111;
}

function main(): void {
  const packageDir = process.argv[2] ?? process.cwd();

  // Windows has no spawn-helper at all: node-pty uses winpty/ConPTY there, so
  // an empty result is expected rather than the #618 symptom.
  if (process.platform === "win32") {
    console.log("fix-node-pty-spawn-helper: win32 uses ConPTY, no spawn-helper to fix.");
    return;
  }

  const nodePtyDir = resolveNodePtyDir(packageDir);
  if (nodePtyDir === null) {
    console.log("fix-node-pty-spawn-helper: node-pty is not installed, nothing to do.");
    return;
  }

  const helpers = findSpawnHelpers(nodePtyDir);
  if (helpers.length === 0) {
    console.error(
      `fix-node-pty-spawn-helper: node-pty resolved to ${nodePtyDir} but no ` +
        `${PREBUILDS_DIR}/*/${HELPER_NAME} was found. The E2E suite will fail with ` +
        `"posix_spawnp failed" — check the node-pty layout.`,
    );
    process.exit(1);
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

if (import.meta.main) {
  main();
}
