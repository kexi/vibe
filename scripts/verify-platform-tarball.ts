#!/usr/bin/env bun

/**
 * Assert that a per-platform npm package would publish its required files.
 *
 * A platform package (`packages/vibe-<platform>-<arch>`) is useless without the
 * staged binary, and ships incomplete legal notices without
 * THIRD-PARTY-LICENSES.md. The `files` glob list in its package.json is the only
 * thing that controls what `npm publish` includes, so a wrong glob (or a missing
 * staging step) would silently publish an empty / non-runnable package. This
 * script runs `npm pack --dry-run --json` (no tarball written) and fails unless
 * the planned contents include BOTH:
 *   - bin/vibe, with an executable mode bit set, and
 *   - THIRD-PARTY-LICENSES.md.
 *
 * It must run AFTER scripts/stage-platform-package.ts has staged the binary and
 * the license into the package dir (the bin/ dirs are gitignored).
 *
 * Usage:
 *   bun run scripts/verify-platform-tarball.ts --package vibe-linux-x64
 *   bun run scripts/verify-platform-tarball.ts --dir packages/vibe-linux-x64
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

interface PackEntry {
  path: string;
  size: number;
  mode: number;
}
interface PackResult {
  files: PackEntry[];
}

// The Windows package ships `bin/vibe.exe`; every other platform ships the
// extensionless `bin/vibe`. The caller derives the right name from the package.
const LICENSE_FILE = "THIRD-PARTY-LICENSES.md";

/** The staged binary's path inside the tarball for a given package directory. */
export function binaryPathFor(dir: string): string {
  return dir.includes("win32") ? "bin/vibe.exe" : "bin/vibe";
}

function parseDir(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") {
      const dir = argv[++i];
      if (!dir) throw new Error("--dir requires a value");
      return dir;
    }
    if (argv[i] === "--package") {
      const pkg = argv[++i];
      if (!pkg) throw new Error("--package requires a value");
      return join("packages", pkg);
    }
    if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(
        "Usage: bun run scripts/verify-platform-tarball.ts (--package <name> | --dir <path>)",
      );
      process.exit(0);
    }
  }
  throw new Error("missing required --package <name> or --dir <path>");
}

/**
 * Validate a `npm pack --dry-run --json` result. Pure so it can be unit-tested
 * without invoking npm. `binName` is the expected binary entry (e.g. `bin/vibe`
 * or `bin/vibe.exe`). Returns the list of problems (empty = OK): a missing
 * required file, or the binary present but not executable.
 */
export function findTarballProblems(files: PackEntry[], binName: string): string[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const problems: string[] = [];

  for (const required of [binName, LICENSE_FILE]) {
    if (!byPath.has(required)) {
      problems.push(`missing required file: ${required}`);
    }
  }

  // The shim chmods +x at launch if needed, but a non-executable published bin
  // is still a smell (and breaks `bin` wiring on some installs), so require the
  // staged mode to carry an execute bit. (Skipped for the .exe: npm tarball mode
  // bits are not meaningful for Windows binaries.)
  const bin = byPath.get(binName);
  if (bin && !binName.endsWith(".exe") && (bin.mode & 0o111) === 0) {
    problems.push(`${binName} is not executable (mode ${bin.mode.toString(8)})`);
  }

  return problems;
}

async function main(): Promise<void> {
  const dir = parseDir(process.argv.slice(2));

  // This G-3 check runs only on Linux/macOS (the CI win32 leg skips it — Bun on
  // Windows cannot spawn the npm.cmd shim; the assertion is platform-independent
  // and covered by the unix legs / the ubuntu-run publish job), so a bare `npm`
  // resolves fine and no shell/.cmd handling is needed.
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], { cwd: dir });
  const parsed = JSON.parse(stdout) as PackResult[];
  const result = parsed[0];
  if (!result || !Array.isArray(result.files)) {
    throw new Error(`unexpected npm pack output for ${dir}`);
  }

  const binName = binaryPathFor(dir);
  const problems = findTarballProblems(result.files, binName);
  if (problems.length > 0) {
    console.error(`✗ ${dir}: tarball is missing required content:`);
    for (const p of problems) {
      console.error(`  - ${p}`);
    }
    process.exit(1);
  }

  console.log(`✓ ${dir}: tarball includes ${binName}, ${LICENSE_FILE}`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`verify-platform-tarball: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
