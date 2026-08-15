#!/usr/bin/env bun

/**
 * Pre-upload gate: assert every expected release file exists on disk, then emit
 * the verified path list the workflow uploads.
 *
 * Before #597 the workflow built its upload list from a glob and asserted only
 * its length, so a missing platform binary could be masked by an unrelated
 * extra file. Here the gate's stdout IS the upload list, one path per line in
 * manifest order, so the verified set and the uploaded set cannot disagree —
 * the divergence class is removed rather than re-checked.
 *
 * Why lstat and not stat: a symlink at an expected path would upload whatever
 * it points at (CWE-59). Symlinks, directories and devices are all reported as
 * problems rather than followed.
 *
 * Usage:
 *   bun run scripts/verify-release-files.ts \
 *     --channel stable --version 3.1.0 --artifacts-dir artifacts [--repo-root .]
 *
 * On success: the resolved paths on stdout (and nothing else), exit 0.
 * On any problem: ::error:: lines on stderr, empty stdout, exit 1.
 */

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expectedReleaseAssets,
  type PlannedAsset,
  type ReleaseChannel,
} from "./release-asset-manifest";

export interface LocalAsset {
  name: string;
  path: string;
}

export interface CliArgs {
  channel: ReleaseChannel;
  version: string;
  artifactsDir: string;
  repoRoot: string;
}

export function parseCliArgs(argv: string[]): CliArgs {
  let channel: string | undefined;
  let version: string | undefined;
  let artifactsDir: string | undefined;
  let repoRoot: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--channel") {
      channel = argv[++i];
    } else if (arg === "--version") {
      version = argv[++i];
    } else if (arg === "--artifacts-dir") {
      artifactsDir = argv[++i];
    } else if (arg === "--repo-root") {
      repoRoot = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (channel !== "stable" && channel !== "beta") {
    throw new Error(`--channel must be stable or beta (got: ${channel ?? "<none>"})`);
  }
  if (version === undefined || version === "") {
    throw new Error("--version is required");
  }
  if (artifactsDir === undefined || artifactsDir === "") {
    throw new Error("--artifacts-dir is required");
  }

  return { channel, version, artifactsDir, repoRoot: repoRoot ?? "." };
}

/**
 * Map each planned asset to the path it must exist at, preserving manifest
 * order (the order the workflow uploads in).
 */
export function resolveAssetPaths(
  assets: PlannedAsset[],
  artifactsDir: string,
  repoRoot: string,
): LocalAsset[] {
  return assets.map((asset) => ({
    name: asset.name,
    path: join(asset.source === "artifacts" ? artifactsDir : repoRoot, asset.name),
  }));
}

/**
 * Report every expected file that is absent, is not a regular file, or is
 * empty. Pure over the filesystem it is pointed at, so tests can drive it with
 * a temp dir; returns the problems (empty = OK).
 *
 * Extra files in the artifacts directory are neither required nor rejected
 * here: they simply never enter the upload list, which is what makes the #597
 * masking case impossible instead of merely unlikely.
 */
export async function findLocalAssetProblems(entries: LocalAsset[]): Promise<string[]> {
  const problems: string[] = [];

  for (const entry of entries) {
    let stats;
    try {
      stats = await lstat(entry.path);
    } catch {
      problems.push(`missing release file: ${entry.name} (expected at ${entry.path})`);
      continue;
    }

    if (!stats.isFile()) {
      problems.push(`release file ${entry.name} is not a regular file: ${entry.path}`);
      continue;
    }

    if (stats.size === 0) {
      problems.push(`release file ${entry.name} is empty: ${entry.path}`);
    }
  }

  return problems;
}

/** Best-effort listing of what the artifacts dir actually holds, for the error report. */
async function describeArtifactsDir(artifactsDir: string): Promise<string> {
  try {
    const names = await readdir(artifactsDir);
    return names.length > 0 ? names.sort().join(", ") : "<empty>";
  } catch {
    return "<unreadable>";
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const planned = expectedReleaseAssets(args.channel, args.version);
  const entries = resolveAssetPaths(planned, args.artifactsDir, args.repoRoot);
  const problems = await findLocalAssetProblems(entries);

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`::error::${problem}`);
    }
    console.error(`Artifacts directory contains: ${await describeArtifactsDir(args.artifactsDir)}`);
    process.exit(1);
  }

  // Internal assertion, not a reachable branch: the workflow turns this stdout
  // into the `gh release create` argument list, so emitting a short list would
  // publish a release missing assets the gate just claimed to have verified.
  if (entries.length !== planned.length) {
    throw new Error(
      `refusing to emit a partial upload list (${entries.length} of ${planned.length} assets)`,
    );
  }

  // stdout carries the upload list and nothing else; the summary goes to stderr.
  console.log(entries.map((entry) => entry.path).join("\n"));
  console.error(`OK: all ${entries.length} expected ${args.channel} release files are present.`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`verify-release-files: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
