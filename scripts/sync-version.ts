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

import { readFile, writeFile, stat } from "node:fs/promises";

const ROOT_PACKAGE_JSON = "package.json";

// Targets to sync version to
const TARGETS = [
  "packages/npm/package.json",
  "packages/core/package.json",
  "packages/native/package.json",
];

interface PackageJson {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

async function readJsonFile<T>(path: string): Promise<T> {
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as T;
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2) + "\n";
  await writeFile(path, content, "utf-8");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
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
  console.log(`Usage: bun run scripts/sync-version.ts [options]

Options:
  --check    Only check if versions match, don't update (exit 1 if mismatch)
  --verbose  Print detailed information
  --help     Show this help message
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const verbose = args.includes("--verbose");
  const help = args.includes("--help") || args.includes("-h");

  if (help) {
    printUsage();
    process.exit(0);
  }

  // Read source version from root package.json
  const rootPackageJsonExists = await fileExists(ROOT_PACKAGE_JSON);
  if (!rootPackageJsonExists) {
    console.error(`Error: ${ROOT_PACKAGE_JSON} not found`);
    process.exit(1);
  }

  const rootPackageJson = await readJsonFile<PackageJson>(ROOT_PACKAGE_JSON);
  const sourceVersion = rootPackageJson.version;

  if (!sourceVersion) {
    console.error(`Error: No version field in ${ROOT_PACKAGE_JSON}`);
    process.exit(1);
  }

  if (verbose) {
    console.log(`Source version: ${sourceVersion} (from ${ROOT_PACKAGE_JSON})`);
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
      updated: "✓",
      unchanged: "=",
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
    process.exit(1);
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
