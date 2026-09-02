#!/usr/bin/env bun

/**
 * Fail-closed gate: refuse to publish a version older than one already released.
 *
 * The hazard (#616): a release run that built its artifacts but never published
 * can be re-run at any later date. `prepare` sees no published release for its
 * tag, reports `should_release=true`, and the run walks the normal path —
 * `gh release edit --draft=false --latest` then moves GitHub's latest pointer
 * back to that old version. #608's tap guard reads `isLatest` AFTER that edit,
 * so it sees the stale release as current and mirrors it into the Homebrew tap.
 * The guard is not wrong; it is asking the wrong question at the wrong time.
 *
 * Fail closed rather than publishing without `--latest`: this repository has no
 * documented back-release use case (release.yml refuses off-main dispatches and
 * `prepare` already refuses a tag that exists without a release), so an older
 * version reaching this point means the operator re-ran a stale run. Publishing
 * it half-configured would burn its tag for real and leave a release nobody
 * asked for; refusing costs one re-dispatch of the current version.
 *
 * Reads the release list as JSON on stdin (`gh release list --json tagName`),
 * which keeps the gate offline and testable, and keeps the API call in the
 * workflow where its auth already lives.
 *
 * Usage:
 *   gh release list --exclude-drafts --exclude-pre-releases --limit 100 --json tagName \
 *     | bun run scripts/assert-release-currency.ts --version 3.2.0
 *
 * Exit 0 when the version is the newest (or ties an existing entry, the
 * idempotent re-run case); exit 1 with an ::error:: line otherwise.
 */

import {
  compareReleaseVersions,
  newestVersion,
  parseReleaseVersion,
  stripTagPrefix,
} from "./release-version-order";

export interface CliArgs {
  version: string;
}

export function parseCliArgs(argv: string[]): CliArgs {
  let version: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version") {
      version = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (version === undefined || version === "") {
    throw new Error("--version is required");
  }

  return { version };
}

/**
 * The tag names in `gh release list --json tagName` output.
 *
 * Throws on anything that is not an array of `{tagName: string}`: an empty or
 * malformed body would otherwise read as "no releases exist yet", which is
 * exactly the answer that lets a stale version through.
 */
export function extractTagNames(stdin: string): string[] {
  const trimmed = stdin.trim();
  if (trimmed === "") {
    throw new Error("no release list on stdin (expected `gh release list --json tagName` output)");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("release list on stdin is not valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("release list on stdin is not a JSON array");
  }

  return parsed.map((entry, index) => {
    const tagName = (entry as { tagName?: unknown } | null)?.tagName;
    if (typeof tagName !== "string" || tagName === "") {
      throw new Error(`release list entry ${index} has no tagName`);
    }
    return tagName;
  });
}

export interface CurrencyVerdict {
  ok: boolean;
  /** The newest already-released version found, if any. */
  newest?: string;
  /** Operator-facing explanation; present only when `ok` is false. */
  problem?: string;
}

/**
 * Decide whether `version` may still be published given the releases that exist.
 *
 * Equal is allowed: a re-run of the CURRENT release re-publishing its own
 * version is the idempotent recovery path #598 made reachable, and it moves
 * nothing backwards.
 */
export function judgeReleaseCurrency(
  version: string,
  existingTags: readonly string[],
): CurrencyVerdict {
  const parsed = parseReleaseVersion(stripTagPrefix(version));
  if (!parsed) {
    return {
      ok: false,
      problem: `version ${JSON.stringify(version)} is not a version this gate can order`,
    };
  }

  const newest = newestVersion(existingTags);
  if (!newest) return { ok: true };

  // Non-null: newestVersion only returns strings it parsed.
  const parsedNewest = parseReleaseVersion(newest)!;
  if (compareReleaseVersions(parsed, parsedNewest) < 0) {
    return {
      ok: false,
      newest,
      problem:
        `refusing to release ${stripTagPrefix(version)}: ${newest} is already released. ` +
        `This run is stale — re-running it would move the latest release, the Homebrew tap ` +
        `and the npm dist-tag back to ${stripTagPrefix(version)}. Dispatch a fresh release ` +
        `for the current version instead.`,
    };
  }

  return { ok: true, newest };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const verdict = judgeReleaseCurrency(args.version, extractTagNames(await readStdin()));

  if (!verdict.ok) {
    console.error(`::error::${verdict.problem}`);
    process.exit(1);
  }

  console.error(
    verdict.newest
      ? `OK: ${stripTagPrefix(args.version)} is at least as new as the newest release (${verdict.newest}).`
      : `OK: no comparable release exists yet; ${stripTagPrefix(args.version)} is the first.`,
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(
      `::error::assert-release-currency: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
