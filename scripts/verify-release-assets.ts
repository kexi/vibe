#!/usr/bin/env bun

/**
 * Assert that a published GitHub Release carries the assets it is supposed to.
 *
 * Two modes:
 *
 *   - Default (no flags): only the license documents are required. The binaries
 *     and .debs are self-describing — a missing one breaks an install loudly —
 *     but LICENSE and THIRD-PARTY-LICENSES.md are inert attachments: drop them
 *     and every download still works while shipping a statically linked binary
 *     with no statement of its terms and none of its crates' required notices.
 *
 *   - `--channel <stable|beta> --version <v>`: the release's asset-name set must
 *     equal the manifest exactly — every expected name present and usable, and
 *     no unexpected name. This is the #597 gate: it replaced the workflows'
 *     asset-COUNT assertions, which counted without naming, so a missing
 *     platform binary could be masked by an unrelated extra file.
 *
 * Usage:
 *   gh release view "$TAG" --json assets | bun run scripts/verify-release-assets.ts
 *   gh release view "$TAG" --json assets \
 *     | bun run scripts/verify-release-assets.ts --channel stable --version 3.1.0
 *   bun run scripts/verify-release-assets.ts assets.json
 */

import { readFile } from "node:fs/promises";
import {
  expectedReleaseAssets,
  LICENSE_DOCUMENT_ASSETS,
  type ReleaseChannel,
} from "./release-asset-manifest";

/**
 * Assets a release must carry beyond its binaries, by exact name. Re-exported
 * from the manifest so the default mode and the --channel mode cannot disagree
 * about what the license documents are called.
 */
export const REQUIRED_ASSETS: readonly string[] = LICENSE_DOCUMENT_ASSETS;

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
export function findAssetProblems(
  assets: ReleaseAsset[],
  required: readonly string[] = REQUIRED_ASSETS,
): string[] {
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

/**
 * Report every asset whose name is not in the expected set. Pure; empty = OK.
 *
 * The other half of set equality: findAssetProblems alone accepts a release
 * that carries every expected asset PLUS a stray one, which is how an extra
 * file could compensate for a missing binary under the old count assertion.
 * Only meaningful in --channel mode, where the expected set is complete.
 */
export function findUnexpectedAssets(
  assets: ReleaseAsset[],
  expectedNames: readonly string[],
): string[] {
  const expected = new Set(expectedNames);
  return assets
    .filter((asset) => !expected.has(asset.name))
    .map((asset) => `unexpected release asset: ${asset.name}`);
}

interface CliOptions {
  file?: string;
  channel?: ReleaseChannel;
  version?: string;
}

/**
 * Parse the CLI surface: an optional positional listing file, plus the optional
 * `--channel`/`--version` pair that switches on full-set verification. The pair
 * must be given together — one without the other would silently fall back to
 * the license-documents-only mode, i.e. a weaker gate than the caller asked for.
 */
export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--channel") {
      const value = argv[++i];
      if (value !== "stable" && value !== "beta") {
        throw new Error(`--channel must be stable or beta (got: ${value ?? "<none>"})`);
      }
      options.channel = value;
    } else if (arg === "--version") {
      const value = argv[++i];
      // Rejected rather than stored: a trailing `--version` with no value
      // leaves options.version undefined, which the pair check below then reads
      // as "neither flag given" and waves through into the license-only mode —
      // the exact silent downgrade that check exists to prevent.
      if (value === undefined || value === "") {
        throw new Error("--version requires a value");
      }
      options.version = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (options.file === undefined) {
      options.file = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }

  if ((options.channel === undefined) !== (options.version === undefined)) {
    throw new Error("--channel and --version must be given together");
  }

  return options;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const raw = options.file ? await readFile(options.file, "utf-8") : await readStdin();
  if (raw.trim() === "") {
    throw new Error("no release asset listing was provided on stdin or as a file argument");
  }

  const fullSet =
    options.channel !== undefined && options.version !== undefined
      ? expectedReleaseAssets(options.channel, options.version).map((asset) => asset.name)
      : undefined;
  const required = fullSet ?? REQUIRED_ASSETS;

  const assets = parseAssets(raw);
  const problems = findAssetProblems(assets, required);
  if (fullSet !== undefined) {
    problems.push(...findUnexpectedAssets(assets, fullSet));
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`::error::${problem}`);
    }
    console.error(`Release assets present: ${assets.map((a) => a.name).join(", ")}`);
    process.exit(1);
  }

  if (fullSet !== undefined) {
    console.log(`OK: release carries all ${fullSet.length} expected assets.`);
    return;
  }
  console.log(`OK: release carries ${REQUIRED_ASSETS.join(" and ")} (${assets.length} assets).`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`verify-release-assets: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
