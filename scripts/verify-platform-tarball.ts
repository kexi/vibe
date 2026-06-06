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

const REQUIRED_FILES = ["bin/vibe", "THIRD-PARTY-LICENSES.md"] as const;

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
 * Validate a `npm pack --dry-run --json` result against REQUIRED_FILES. Pure so
 * it can be unit-tested without invoking npm. Returns the list of problems
 * (empty = OK): a missing required file, or bin/vibe present but not executable.
 */
export function findTarballProblems(files: PackEntry[]): string[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const problems: string[] = [];

  for (const required of REQUIRED_FILES) {
    if (!byPath.has(required)) {
      problems.push(`missing required file: ${required}`);
    }
  }

  // The shim chmods +x at launch if needed, but a non-executable published bin
  // is still a smell (and breaks `bin` wiring on some installs), so require the
  // staged mode to carry an execute bit.
  const bin = byPath.get("bin/vibe");
  if (bin && (bin.mode & 0o111) === 0) {
    problems.push(`bin/vibe is not executable (mode ${bin.mode.toString(8)})`);
  }

  return problems;
}

async function main(): Promise<void> {
  const dir = parseDir(process.argv.slice(2));

  // On Windows `npm` is a `.cmd` batch file: Node's execFile cannot spawn it
  // directly (uv_spawn ENOENT, even with the `.cmd` name) because a batch file
  // needs cmd.exe — hence `shell: true` on win32. The args here are FIXED
  // literals (no interpolation) and the variable `dir` is passed via `cwd`, not
  // the command line, so the shell sees no attacker-controlled input.
  const isWin = process.platform === "win32";
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: dir,
    shell: isWin,
  });
  const parsed = JSON.parse(stdout) as PackResult[];
  const result = parsed[0];
  if (!result || !Array.isArray(result.files)) {
    throw new Error(`unexpected npm pack output for ${dir}`);
  }

  const problems = findTarballProblems(result.files);
  if (problems.length > 0) {
    console.error(`✗ ${dir}: tarball is missing required content:`);
    for (const p of problems) {
      console.error(`  - ${p}`);
    }
    process.exit(1);
  }

  console.log(`✓ ${dir}: tarball includes ${REQUIRED_FILES.join(", ")}`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`verify-platform-tarball: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
