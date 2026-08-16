#!/usr/bin/env bun

/**
 * Decide which npm dist-tag a publish may claim.
 *
 * The hazard (#616): `npm publish` with no `--tag` writes the `latest`
 * dist-tag. publish-npm.yml is triggered by `workflow_run`, and a completed
 * `workflow_run` can be re-fired long after the release it followed — so a
 * re-run for 3.1.0 after 3.2.0 shipped would silently move every `npm install
 * @kexi/vibe` back a version. Nothing in the publish path looks at the
 * registry's current `latest` today; this is that look.
 *
 * Why a non-default tag instead of failing: unlike the GitHub release path
 * (#616 hazard 1, which fails closed), republishing an old version to npm is a
 * legitimate repair — a platform package whose first publish failed still needs
 * its bytes on the registry. Publishing it under `previous` makes those bytes
 * installable by exact version without touching what `latest` resolves to.
 *
 * Usage:
 *   bun run scripts/resolve-npm-dist-tag.ts --version 3.1.0 --registry-latest 3.2.0
 *   bun run scripts/resolve-npm-dist-tag.ts --version 3.1.0 --registry-latest ""
 *
 * Prints the tag to publish under on stdout (`latest` or `previous`) and
 * nothing else, so the workflow can capture it directly.
 */

import {
  compareReleaseVersions,
  parseReleaseVersion,
  stripTagPrefix,
} from "./release-version-order";

/** The dist-tag an older-than-latest version is published under instead. */
export const NON_DEFAULT_DIST_TAG = "previous";

export interface CliArgs {
  version: string;
  /** The registry's current `latest`; empty when the package has none yet. */
  registryLatest: string;
}

export function parseCliArgs(argv: string[]): CliArgs {
  let version: string | undefined;
  let registryLatest: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version") {
      version = argv[++i];
    } else if (arg === "--registry-latest") {
      // Distinguished from "flag absent": an unpublished package legitimately
      // has no latest, and the workflow passes "" for it. Reading that as a
      // missing flag would be indistinguishable from a forgotten argument.
      const value = argv[++i];
      if (value === undefined) {
        throw new Error('--registry-latest requires a value (pass "" when the package has none)');
      }
      registryLatest = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (version === undefined || version === "") {
    throw new Error("--version is required");
  }
  if (registryLatest === undefined) {
    throw new Error("--registry-latest is required");
  }

  return { version, registryLatest };
}

/**
 * The dist-tag `version` may claim, given what the registry currently calls
 * `latest`.
 *
 * `latest` when the version is newer than, or equal to, the registry's — equal
 * covers the idempotent re-publish of the current release. Anything the gate
 * cannot order (an unparseable version on either side) fails closed onto the
 * non-default tag: a tag it cannot reason about must not be allowed to move
 * `latest`.
 */
export function resolveDistTag(version: string, registryLatest: string): string {
  const parsed = parseReleaseVersion(stripTagPrefix(version));
  if (!parsed) return NON_DEFAULT_DIST_TAG;

  const trimmedLatest = registryLatest.trim();
  // A package with no latest yet: this publish creates it, so it is latest by
  // definition. `npm view` prints nothing for an unpublished package, which is
  // how the workflow arrives here with an empty string.
  if (trimmedLatest === "") return "latest";

  const parsedLatest = parseReleaseVersion(stripTagPrefix(trimmedLatest));
  if (!parsedLatest) return NON_DEFAULT_DIST_TAG;

  return compareReleaseVersions(parsed, parsedLatest) >= 0 ? "latest" : NON_DEFAULT_DIST_TAG;
}

function main(): void {
  const args = parseCliArgs(process.argv.slice(2));
  const tag = resolveDistTag(args.version, args.registryLatest);

  if (tag !== "latest") {
    console.error(
      `::warning::publishing ${stripTagPrefix(args.version)} under the "${tag}" dist-tag: ` +
        `the registry's latest is ${args.registryLatest.trim() || "<none>"}, which this version does not supersede.`,
    );
  }

  // stdout carries the tag and nothing else; the workflow reads it directly.
  console.log(tag);
}

if (import.meta.main) {
  try {
    main();
  } catch (err: unknown) {
    console.error(
      `::error::resolve-npm-dist-tag: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
