#!/usr/bin/env bun

/**
 * Assert that a published GitHub Release carries the license documents.
 *
 * The binaries and .debs are self-describing — a missing one breaks an install
 * loudly — but LICENSE and THIRD-PARTY-LICENSES.md are inert attachments: drop
 * them and every download still works while shipping a statically linked binary
 * with no statement of its terms and none of its crates' required notices. No
 * other check in the release path looks at them, so this is that check, in the
 * same spirit as verify-deb.ts guarding the .deb's copyright members.
 *
 * The asset-count assertion in the workflow is not a substitute: it counts
 * assets without naming them, so uploading two extra binaries would satisfy it
 * while both license files were absent.
 *
 * Usage:
 *   gh release view "$TAG" --json assets | bun run scripts/verify-release-assets.ts
 *   bun run scripts/verify-release-assets.ts assets.json
 */

import { readFile } from "node:fs/promises";

/** Assets a release must carry beyond its binaries, by exact name. */
export const REQUIRED_ASSETS = ["LICENSE", "THIRD-PARTY-LICENSES.md"];

/**
 * One entry of `gh release view --json assets`, narrowed to what we check.
 *
 * `size` and `state` are optional on the TYPE but not in practice: the real
 * producer always emits both (verified against the published v3.0.0 release),
 * as does the REST API this mirrors. They stay optional because the JSON is
 * untrusted input that must be representable before it can be judged — absence
 * is then reported as a problem rather than silently accepted.
 */
export interface ReleaseAsset {
  name: string;
  size?: number;
  state?: string;
}

/**
 * Pull the asset list out of `gh release view --json assets` output.
 *
 * Accepts either the wrapper object gh emits or a bare array, so the script can
 * be fed `--json assets` directly or `--jq .assets` without a second flag to
 * keep in sync with the workflow.
 */
export function parseAssets(raw: string): ReleaseAsset[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("release asset listing is not valid JSON");
  }

  const isWrapped =
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as { assets?: unknown }).assets);
  const list = isWrapped ? (parsed as { assets: unknown[] }).assets : parsed;
  if (!Array.isArray(list)) {
    throw new Error("release asset listing has no 'assets' array");
  }

  return list.map((entry, index) => {
    const isObject = typeof entry === "object" && entry !== null;
    const name = isObject ? (entry as { name?: unknown }).name : undefined;
    if (typeof name !== "string") {
      throw new Error(`release asset #${index} has no name`);
    }
    // A wrong-typed size/state is narrowed to undefined rather than thrown on,
    // so findAssetProblems can report it per-asset with the name attached. Only
    // required assets matter, and a malformed entry for some unrelated binary
    // should not abort the check that the license documents are present.
    const record = entry as { size?: unknown; state?: unknown };
    return {
      name,
      size: typeof record.size === "number" ? record.size : undefined,
      state: typeof record.state === "string" ? record.state : undefined,
    };
  });
}

/**
 * Report every required asset that is missing or unusable. Pure so it can be
 * unit-tested without a release to point at; returns the problems (empty = OK).
 *
 * A zero-byte or non-`uploaded` asset counts as missing: gh creates the asset
 * record before the bytes land, so presence of the name alone would accept a
 * release whose LICENSE downloads as an empty file.
 *
 * Why absent `size`/`state` is a problem rather than a pass: the real producer
 * always sends both, so a listing without them is not a lenient older format,
 * it is a payload this script does not understand. Treating unknown as fine
 * would make the one case where verification cannot be performed the one case
 * that always succeeds — precisely inverted for a release gate.
 */
export function findAssetProblems(assets: ReleaseAsset[], required = REQUIRED_ASSETS): string[] {
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  const problems: string[] = [];

  for (const name of required) {
    const asset = byName.get(name);
    if (asset === undefined) {
      problems.push(`missing required release asset: ${name}`);
      continue;
    }

    if (asset.size === undefined) {
      problems.push(`release asset ${name} reports no size`);
    } else if (asset.size <= 0) {
      problems.push(`release asset ${name} is empty (${asset.size} bytes)`);
    }

    if (asset.state === undefined) {
      problems.push(`release asset ${name} reports no upload state`);
    } else if (asset.state !== "uploaded") {
      problems.push(`release asset ${name} is in state '${asset.state}', expected 'uploaded'`);
    }
  }

  return problems;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const raw = arg ? await readFile(arg, "utf-8") : await readStdin();
  if (raw.trim() === "") {
    throw new Error("no release asset listing was provided on stdin or as a file argument");
  }

  const assets = parseAssets(raw);
  const problems = findAssetProblems(assets);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`::error::${problem}`);
    }
    console.error(`Release assets present: ${assets.map((a) => a.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`OK: release carries ${REQUIRED_ASSETS.join(" and ")} (${assets.length} assets).`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`verify-release-assets: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
