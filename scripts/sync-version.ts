#!/usr/bin/env -S deno run --allow-read --allow-write

/**
 * Sync version from deno.json to all package.json files
 *
 * This script uses deno.json as the single source of truth (SSoT) for
 * versioning and propagates the version to all npm packages.
 *
 * Usage:
 *   deno run --allow-read --allow-write scripts/sync-version.ts
 *   deno task sync-version
 *
 * Options:
 *   --check    Only check if versions match, don't update (exit 1 if mismatch)
 *   --verbose  Print detailed information
 */

const DENO_JSON = "deno.json";

// Targets to sync version to
const TARGETS = [
  "package.json",
  "packages/npm/package.json",
  "packages/core/package.json",
  "packages/core/deno.json",
  "packages/native/package.json",
];

interface PackageJson {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

interface DenoJson {
  version?: string;
  [key: string]: unknown;
}

async function readJsonFile<T>(path: string): Promise<T> {
  const content = await Deno.readTextFile(path);
  return JSON.parse(content) as T;
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2) + "\n";
  await Deno.writeTextFile(path, content);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
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

  const isUnchanged = oldVersion === sourceVersion;
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
    await writeJsonFile(targetPath, pkg);
  }

  return {
    path: targetPath,
    oldVersion,
    newVersion: sourceVersion,
    status: "updated",
  };
}

function printUsage(): void {
  console.log(`Usage: deno run --allow-read --allow-write scripts/sync-version.ts [options]

Options:
  --check    Only check if versions match, don't update (exit 1 if mismatch)
  --verbose  Print detailed information
  --help     Show this help message
`);
}

async function main(): Promise<void> {
  const args = Deno.args;
  const checkOnly = args.includes("--check");
  const verbose = args.includes("--verbose");
  const help = args.includes("--help") || args.includes("-h");

  if (help) {
    printUsage();
    Deno.exit(0);
  }

  // Read source version from deno.json
  const denoJsonExists = await fileExists(DENO_JSON);
  if (!denoJsonExists) {
    console.error(`Error: ${DENO_JSON} not found`);
    Deno.exit(1);
  }

  const denoJson = await readJsonFile<DenoJson>(DENO_JSON);
  const sourceVersion = denoJson.version;

  if (!sourceVersion) {
    console.error(`Error: No version field in ${DENO_JSON}`);
    Deno.exit(1);
  }

  if (verbose) {
    console.log(`Source version: ${sourceVersion} (from ${DENO_JSON})`);
    console.log("");
  }

  // Sync to all targets
  const results: SyncResult[] = [];
  for (const target of TARGETS) {
    const result = await syncVersion(sourceVersion, target, checkOnly);
    results.push(result);
  }

  // Print results
  let hasMismatch = false;
  let hasUpdated = false;

  for (const result of results) {
    const statusIcon = {
      "updated": "✓",
      "unchanged": "=",
      "not-found": "?",
    }[result.status];

    if (result.status === "not-found") {
      if (verbose) {
        console.log(`${statusIcon} ${result.path}: not found`);
      }
    } else if (result.status === "unchanged") {
      if (verbose) {
        console.log(`${statusIcon} ${result.path}: ${result.oldVersion} (unchanged)`);
      }
    } else {
      hasUpdated = true;
      hasMismatch = true;
      if (checkOnly) {
        console.log(`✗ ${result.path}: ${result.oldVersion} → ${result.newVersion} (mismatch)`);
      } else {
        console.log(`${statusIcon} ${result.path}: ${result.oldVersion} → ${result.newVersion}`);
      }
    }
  }

  // Exit with appropriate code
  if (checkOnly && hasMismatch) {
    console.log("");
    console.log("Version mismatch detected. Run without --check to update.");
    Deno.exit(1);
  }

  if (!checkOnly && hasUpdated) {
    console.log("");
    console.log(`All versions synced to ${sourceVersion}`);
  } else if (!hasUpdated && verbose) {
    console.log("");
    console.log("All versions are already in sync.");
  }
}

main();
