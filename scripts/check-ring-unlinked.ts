#!/usr/bin/env bun

/**
 * Assert that no crate in the workspace actually depends on `ring`.
 *
 * vibe's TLS stack elects aws-lc-rs; `ring` appears in `cargo metadata`'s
 * conservative full graph (it is an optional/alternative backend that nothing
 * selects) but must never end up linked into the shipped binary. `cargo tree -i`
 * inverts the graph and prints the dependents of a package, so an empty result
 * ("nothing to print") is the proof that the link never happens.
 *
 * Why this is a separate check rather than an assertion about
 * THIRD-PARTY-LICENSES.md: `ring` is licensed `Apache-2.0 AND ISC`, so it now
 * legitimately appears in that file's notice appendix. Its presence there says
 * only that the conservative crate list contains it — it is no longer evidence
 * either way about linkage, and reading it as such would silently retire the
 * signal this check exists to provide.
 *
 * Usage:
 *   bun run scripts/check-ring-unlinked.ts
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FORBIDDEN_CRATE = "ring";
const MANIFEST = "rust/Cargo.toml";

/**
 * True when `cargo tree -i` reported no dependents. cargo prints the
 * "nothing to print" notice on stderr and leaves stdout empty; a real dependent
 * would be a tree on stdout.
 */
export function hasNoDependents(stdout: string): boolean {
  return stdout.trim() === "";
}

async function main(): Promise<void> {
  const { stdout } = await execFileAsync("cargo", [
    "tree",
    "-i",
    FORBIDDEN_CRATE,
    "--manifest-path",
    MANIFEST,
  ]);

  if (!hasNoDependents(stdout)) {
    console.error(
      `✗ ${FORBIDDEN_CRATE} is reachable from the workspace; vibe's TLS stack must stay on aws-lc-rs:`,
    );
    console.error(stdout.trimEnd());
    process.exit(1);
  }

  console.log(`✓ ${FORBIDDEN_CRATE} has no dependents in the workspace (not linked).`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`check-ring-unlinked: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
