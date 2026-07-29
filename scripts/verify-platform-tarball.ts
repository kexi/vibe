#!/usr/bin/env bun

/**
 * Assert that a published npm package would pack its required files.
 *
 * A platform package (`packages/vibe-<platform>-<arch>`) is useless without the
 * staged binary, and ships incomplete legal notices without
 * THIRD-PARTY-LICENSES.md. The shim package (`packages/npm`) is useless without
 * its committed launcher. The `files` glob list in each package.json is the
 * only thing that controls what `npm publish` includes, so a wrong glob (or a
 * missing staging step) would silently publish an empty / non-runnable package.
 * This script runs `npm pack --dry-run --json` (no tarball written) and fails
 * unless the planned contents include ALL of the package's expectation:
 *   - platform packages: bin/vibe (executable; bin/vibe.exe on win32),
 *     THIRD-PARTY-LICENSES.md, and LICENSE;
 *   - the shim: bin/vibe.cjs and LICENSE (committed non-executable — npm wires
 *     the bin at install time — and it ships no THIRD-PARTY-LICENSES.md since
 *     nothing is statically linked into it).
 * LICENSE is vibe's own MIT terms; npm includes a top-level LICENSE
 * irrespective of `files`, so its absence means staging did not run.
 *
 * It must run AFTER the staging step has copied the files into the package dir
 * (scripts/stage-platform-package.ts for platform packages; a `cp LICENSE`
 * step for the shim — the bin/ dirs and staged LICENSE copies are gitignored).
 *
 * Usage:
 *   bun run scripts/verify-platform-tarball.ts --package vibe-linux-x64
 *   bun run scripts/verify-platform-tarball.ts --package npm
 *   bun run scripts/verify-platform-tarball.ts --dir packages/vibe-linux-x64
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join } from "node:path";

const execFileAsync = promisify(execFile);

interface PackEntry {
  path: string;
  size: number;
  mode: number;
}
interface PackResult {
  files: PackEntry[];
}

const THIRD_PARTY_LICENSE_FILE = "THIRD-PARTY-LICENSES.md";
const PROJECT_LICENSE_FILE = "LICENSE";

/** What a given package's planned tarball must contain. */
export interface TarballExpectation {
  /** Entries that must be present in the packed file list. */
  requiredFiles: string[];
  /** Entry whose mode must carry an execute bit; absent when none applies. */
  executableEntry?: string;
}

// The Windows package ships `bin/vibe.exe`; every other platform ships the
// extensionless `bin/vibe`. The caller derives the right name from the package.
/** The staged binary's path inside the tarball for a given package directory. */
export function binaryPathFor(dir: string): string {
  return dir.includes("win32") ? "bin/vibe.exe" : "bin/vibe";
}

/** The expectation for a package dir (`packages/npm` or `packages/vibe-*`). */
export function expectationFor(dir: string): TarballExpectation {
  const isShim = basename(dir) === "npm";
  if (isShim) {
    // The launcher is committed 0644 (npm chmods the wired bin at install
    // time), so no executable-bit requirement applies.
    return { requiredFiles: ["bin/vibe.cjs", PROJECT_LICENSE_FILE] };
  }

  const bin = binaryPathFor(dir);
  return {
    requiredFiles: [bin, THIRD_PARTY_LICENSE_FILE, PROJECT_LICENSE_FILE],
    // npm tarball mode bits are not meaningful for Windows binaries.
    executableEntry: bin.endsWith(".exe") ? undefined : bin,
  };
}

/**
 * Validate a `npm pack --dry-run --json` result against an expectation. Pure so
 * it can be unit-tested without invoking npm. Returns the list of problems
 * (empty = OK): a missing required file, or the executable entry present but
 * not executable.
 */
export function findTarballProblems(files: PackEntry[], expectation: TarballExpectation): string[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const problems: string[] = [];

  for (const required of expectation.requiredFiles) {
    if (!byPath.has(required)) {
      problems.push(`missing required file: ${required}`);
    }
  }

  // The shim chmods +x at launch if needed, but a non-executable published bin
  // is still a smell (and breaks `bin` wiring on some installs), so require the
  // staged mode to carry an execute bit where one is expected.
  const bin = expectation.executableEntry ? byPath.get(expectation.executableEntry) : undefined;
  if (bin && (bin.mode & 0o111) === 0) {
    problems.push(
      `${expectation.executableEntry} is not executable (mode ${bin.mode.toString(8)})`,
    );
  }

  return problems;
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

  const expectation = expectationFor(dir);
  const problems = findTarballProblems(result.files, expectation);
  if (problems.length > 0) {
    console.error(`✗ ${dir}: tarball is missing required content:`);
    for (const p of problems) {
      console.error(`  - ${p}`);
    }
    process.exit(1);
  }

  console.log(`✓ ${dir}: tarball includes ${expectation.requiredFiles.join(", ")}`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`verify-platform-tarball: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
