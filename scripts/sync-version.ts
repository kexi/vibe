#!/usr/bin/env bun

/**
 * Sync version from root package.json to all package.json files
 *
 * This script uses the root package.json as the single source of truth (SSoT) for
 * versioning and propagates the version to all npm packages.
 *
 * Usage:
 *   bun run scripts/sync-version.ts
 *
 * Options:
 *   --check    Only check if versions match, don't update (exit 1 if mismatch)
 *   --verbose  Print detailed information
 */

import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

const execFileAsync = promisify(execFile);

// All file operations are resolved against this root. Production uses the
// process cwd (the repo root); tests point it at a throwaway fixture dir so the
// real repo files are never mutated. `runSync` threads it through every helper.
let baseDir = ".";
function resolvePath(relative: string): string {
  return join(baseDir, relative);
}

const ROOT_PACKAGE_JSON = "package.json";

// JSON targets whose top-level `version` field is synced to the root version.
// The four `packages/vibe-<platform>-<arch>/package.json` are the Phase-5
// per-platform npm packages; @kexi/vibe (packages/npm) additionally has its
// optionalDependency pins synced (see PACKAGE_JSON_WITH_OPTIONAL_DEPS below).
// Phase 6 removed the dead TS distribution targets (packages/core,
// packages/native, jsr.json) — those packages and the JSR feed no longer exist.
const TARGETS = [
  "packages/npm/package.json",
  "packages/vibe-linux-x64/package.json",
  "packages/vibe-linux-arm64/package.json",
  "packages/vibe-darwin-x64/package.json",
  "packages/vibe-darwin-arm64/package.json",
  "packages/vibe-win32-x64/package.json",
];

// Rust crates whose `[package] version` is hand-pinned to the release version
// and must track the root package.json. The vibe-native crate is intentionally
// EXCLUDED: it carries an independent version (0.12.0), so syncing it to the
// release version would be wrong.
const CARGO_TARGETS = [
  "rust/crates/vibe/Cargo.toml",
  "rust/crates/vibe-core/Cargo.toml",
  "rust/crates/vibe-test-support/Cargo.toml",
];

// @kexi/vibe pins its four per-platform binaries as EXACT-version
// optionalDependencies (security D-2). They must equal the root version so the
// shim never resolves a mismatched binary.
const PACKAGE_JSON_WITH_OPTIONAL_DEPS = "packages/npm/package.json";
const PLATFORM_OPTIONAL_DEPS = [
  "@kexi/vibe-linux-x64",
  "@kexi/vibe-linux-arm64",
  "@kexi/vibe-darwin-x64",
  "@kexi/vibe-darwin-arm64",
  "@kexi/vibe-win32-x64",
];

// The per-platform npm package directories that MUST exist, derived from the
// optionalDependency list (the single enumeration of supported platforms here).
// Phase-6 follow-up guard: the platform set is duplicated across ~10 places
// (shim, this script, stage script, flake, the four workflow matrices, the four
// platform package.json). A full SSoT refactor is out of scope; this cheap
// guard at least catches a NEW `packages/vibe-*` dir that nobody wired into
// this script — pairing with the not-found check (which catches a removed one).
const EXPECTED_PLATFORM_PACKAGE_DIRS = PLATFORM_OPTIONAL_DEPS.map(
  (name) => `packages/${name.replace("@kexi/", "")}`,
);

interface PackageJson {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

async function readJsonFile<T>(path: string): Promise<T> {
  const content = await readFile(resolvePath(path), "utf-8");
  return JSON.parse(content) as T;
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2) + "\n";
  await writeFile(resolvePath(path), content, "utf-8");
  // pnpm exec (not npx): prettier is a pinned devDependency, so this runs the
  // locked version. npx would resolve/download an unpinned prettier (version
  // drift / supply-chain risk) — see .claude/rules/package-json.md. Skipped when
  // baseDir is a test fixture: prettier is not wired to format an arbitrary temp
  // dir, and the test asserts on the raw written JSON, not its formatting.
  if (baseDir === ".") {
    // On Windows `pnpm` is a `.cmd` batch file that Node's execFile cannot spawn
    // directly — it needs cmd.exe, hence `shell: true` on win32. `path` here is
    // an internal fixed TARGETS entry (e.g. "packages/npm/package.json"), never
    // attacker input, so passing it through the shell is safe.
    const isWin = process.platform === "win32";
    await execFileAsync("pnpm", ["exec", "prettier", "--write", path], { shell: isWin });
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(resolvePath(path));
    return true;
  } catch {
    return false;
  }
}

interface SyncResult {
  path: string;
  oldVersion: string;
  newVersion: string;
  status: "updated" | "unchanged" | "not-found";
}

async function syncVersion(
  sourceVersion: string,
  targetPath: string,
  dryRun: boolean,
): Promise<SyncResult> {
  const exists = await fileExists(targetPath);
  if (!exists) {
    return {
      path: targetPath,
      oldVersion: "",
      newVersion: sourceVersion,
      status: "not-found",
    };
  }

  const pkg = await readJsonFile<PackageJson>(targetPath);
  const oldVersion = pkg.version ?? "0.0.0";

  // For @kexi/vibe the optionalDependency pins also count: a drift there must be
  // reported as a mismatch even when the top-level version already matches, so
  // the --check gate cannot pass with stale platform-package pins.
  const optionalDepsNeedSync =
    targetPath === PACKAGE_JSON_WITH_OPTIONAL_DEPS && optionalDepsMismatch(pkg, sourceVersion);

  const isUnchanged = oldVersion === sourceVersion && !optionalDepsNeedSync;
  if (isUnchanged) {
    return {
      path: targetPath,
      oldVersion,
      newVersion: sourceVersion,
      status: "unchanged",
    };
  }

  if (!dryRun) {
    pkg.version = sourceVersion;
    if (targetPath === PACKAGE_JSON_WITH_OPTIONAL_DEPS) {
      setOptionalDepPins(pkg, sourceVersion);
    }
    await writeJsonFile(targetPath, pkg);
  }

  return {
    path: targetPath,
    oldVersion,
    newVersion: sourceVersion,
    status: "updated",
  };
}

function getOptionalDeps(pkg: PackageJson): Record<string, string> {
  const deps = pkg.optionalDependencies;
  if (deps && typeof deps === "object") {
    return deps as Record<string, string>;
  }
  return {};
}

function optionalDepsMismatch(pkg: PackageJson, sourceVersion: string): boolean {
  const deps = getOptionalDeps(pkg);
  return PLATFORM_OPTIONAL_DEPS.some((name) => deps[name] !== sourceVersion);
}

function setOptionalDepPins(pkg: PackageJson, sourceVersion: string): void {
  const deps = getOptionalDeps(pkg);
  for (const name of PLATFORM_OPTIONAL_DEPS) {
    deps[name] = sourceVersion;
  }
  pkg.optionalDependencies = deps;
}

/**
 * Sync a Cargo.toml `[package] version`. Edits the single `version = "..."` line
 * with a regex rather than round-tripping through a TOML serializer: a full
 * re-serialize would drop the crates' extensive load-bearing comments and
 * reorder keys. smol-toml is used only to READ the current value for the check.
 */
async function syncCargoVersion(
  sourceVersion: string,
  targetPath: string,
  dryRun: boolean,
): Promise<SyncResult> {
  const exists = await fileExists(targetPath);
  if (!exists) {
    return { path: targetPath, oldVersion: "", newVersion: sourceVersion, status: "not-found" };
  }

  const content = await readFile(resolvePath(targetPath), "utf-8");
  const parsed = parseToml(content) as { package?: { version?: string } };
  const oldVersion = parsed.package?.version ?? "0.0.0";

  const isUnchanged = oldVersion === sourceVersion;
  if (isUnchanged) {
    return { path: targetPath, oldVersion, newVersion: sourceVersion, status: "unchanged" };
  }

  if (!dryRun) {
    // Replace only the FIRST `version = "..."` (the [package] one). The crates
    // declare it on the line directly under [package], before any other table,
    // so the first match is the package version, never a dependency version.
    const updated = content.replace(/^version\s*=\s*"[^"]*"/m, `version = "${sourceVersion}"`);
    if (updated === content) {
      throw new Error(`could not find a [package] version line in ${targetPath}`);
    }
    await writeFile(resolvePath(targetPath), updated, "utf-8");
  }

  return { path: targetPath, oldVersion, newVersion: sourceVersion, status: "updated" };
}

/**
 * Detect `packages/vibe-*` directories on disk that are NOT in the expected
 * platform list. A 5th platform added as a package dir but not registered in
 * EXPECTED_PLATFORM_PACKAGE_DIRS (and therefore not in TARGETS / the optional
 * deps) would otherwise ship with an unsynced version. Returns the unexpected
 * dir names (empty = OK).
 */
async function findUnregisteredPlatformDirs(): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(resolvePath("packages"), { withFileTypes: true });
  } catch {
    return [];
  }
  const expected = new Set(EXPECTED_PLATFORM_PACKAGE_DIRS.map((p) => p.replace("packages/", "")));
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith("vibe-") && /-(x64|arm64)$/.test(e.name))
    .map((e) => e.name)
    .filter((name) => !expected.has(name));
}

function printUsage(): void {
  console.log(`Usage: bun run scripts/sync-version.ts [options]

Options:
  --check    Only check if versions match, don't update (exit 1 if mismatch)
  --verbose  Print detailed information
  --help     Show this help message
`);
}

export interface RunSyncOptions {
  /** Root directory all paths resolve against. Defaults to the process cwd. */
  cwd?: string;
  /** --check: report drift without writing, and exit nonzero on any drift. */
  checkOnly?: boolean;
  verbose?: boolean;
  /** Sink for human-readable lines; defaults to console.log. */
  log?: (line: string) => void;
}

export interface RunSyncResult {
  /** The process exit code this run should produce (0 = success). */
  exitCode: number;
  /** Per-target sync outcomes (used by tests to assert what changed). */
  results: SyncResult[];
  /** `packages/vibe-*` dirs on disk not registered in the platform list. */
  unregistered: string[];
  sourceVersion: string;
}

/**
 * Core orchestration, decoupled from process.argv / process.exit so it can be
 * driven against a temp fixture in tests. Mutates files under `cwd` unless
 * `checkOnly` is set. The CLI wrapper (`main`) translates the returned exitCode
 * into a real process exit.
 */
export async function runSync(options: RunSyncOptions = {}): Promise<RunSyncResult> {
  const checkOnly = options.checkOnly ?? false;
  const verbose = options.verbose ?? false;
  const log = options.log ?? ((line: string) => console.log(line));
  baseDir = options.cwd ?? ".";

  try {
    const rootPackageJsonExists = await fileExists(ROOT_PACKAGE_JSON);
    if (!rootPackageJsonExists) {
      log(`Error: ${ROOT_PACKAGE_JSON} not found`);
      return { exitCode: 1, results: [], unregistered: [], sourceVersion: "" };
    }

    const rootPackageJson = await readJsonFile<PackageJson>(ROOT_PACKAGE_JSON);
    const sourceVersion = rootPackageJson.version;

    if (!sourceVersion) {
      log(`Error: No version field in ${ROOT_PACKAGE_JSON}`);
      return { exitCode: 1, results: [], unregistered: [], sourceVersion: "" };
    }

    if (verbose) {
      log(`Source version: ${sourceVersion} (from ${ROOT_PACKAGE_JSON})`);
      log("");
    }

    // Sync to all targets (JSON package manifests, then Rust crates)
    const results: SyncResult[] = [];
    for (const target of TARGETS) {
      results.push(await syncVersion(sourceVersion, target, checkOnly));
    }
    for (const target of CARGO_TARGETS) {
      results.push(await syncCargoVersion(sourceVersion, target, checkOnly));
    }

    let hasMismatch = false;
    let hasUpdated = false;
    let hasNotFound = false;

    for (const result of results) {
      const statusIcon = {
        updated: "✓",
        unchanged: "=",
        "not-found": "?",
      }[result.status];

      if (result.status === "not-found") {
        // Every entry in TARGETS / CARGO_TARGETS is an EXPECTED file. A missing
        // one means the SSoT and the package layout disagree — e.g. a Phase-6
        // deletion that did not update this list, or a newly added platform
        // whose dir is absent. In --check mode that MUST fail: --check is the
        // only version-consistency gate, so a silent "not-found" pass would let
        // those drifts ship. (Non-check mode reports it but still syncs.)
        hasNotFound = true;
        log(`${statusIcon} ${result.path}: not found (expected target missing)`);
      } else if (result.status === "unchanged") {
        if (verbose) {
          log(`${statusIcon} ${result.path}: ${result.oldVersion} (unchanged)`);
        }
      } else {
        hasUpdated = true;
        hasMismatch = true;
        if (checkOnly) {
          log(`✗ ${result.path}: ${result.oldVersion} → ${result.newVersion} (mismatch)`);
        } else {
          log(`${statusIcon} ${result.path}: ${result.oldVersion} → ${result.newVersion}`);
        }
      }
    }

    // In --check mode also flag a platform package dir that exists on disk but
    // is not registered here (a 5th platform that bypassed the SSoT list).
    let hasUnregistered = false;
    let unregistered: string[] = [];
    if (checkOnly) {
      unregistered = await findUnregisteredPlatformDirs();
      if (unregistered.length > 0) {
        hasUnregistered = true;
        for (const name of unregistered) {
          log(`✗ packages/${name}: platform package not registered in sync-version.ts`);
        }
      }
    }

    // In --check mode a version mismatch, a missing expected target, or an
    // unregistered platform package are all hard failures: the gate exists to
    // catch any drift between the SSoT and the tracked files.
    if (checkOnly && (hasMismatch || hasNotFound || hasUnregistered)) {
      log("");
      if (hasMismatch) {
        log("Version mismatch detected. Run without --check to update.");
      }
      if (hasNotFound) {
        log("Expected target file(s) missing. Update the TARGETS/CARGO_TARGETS list.");
      }
      if (hasUnregistered) {
        log("Unregistered platform package(s) found. Add them to PLATFORM_OPTIONAL_DEPS/TARGETS.");
      }
      return { exitCode: 1, results, unregistered, sourceVersion };
    }

    if (!checkOnly && hasUpdated) {
      log("");
      log(`All versions synced to ${sourceVersion}`);
    } else if (!hasUpdated && verbose) {
      log("");
      log("All versions are already in sync.");
    }

    return { exitCode: 0, results, unregistered, sourceVersion };
  } finally {
    // Restore the default so a test that omits cwd (or the CLI) is unaffected by
    // a previous run that set a fixture dir.
    baseDir = ".";
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const help = args.includes("--help") || args.includes("-h");

  if (help) {
    printUsage();
    process.exit(0);
  }

  const { exitCode } = await runSync({
    checkOnly: args.includes("--check"),
    verbose: args.includes("--verbose"),
  });
  process.exit(exitCode);
}

// Only run the CLI when executed directly (bun sets import.meta.main). Under
// vitest/vite import.meta.main is undefined, so importing this module for tests
// does not trigger a real sync against the repo.
if (import.meta.main) {
  main();
}
