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
 *   npm view "$PKG" dist-tags.latest --json > view.json; echo $? > code
 *   bun run scripts/resolve-npm-dist-tag.ts --version 3.1.0 \
 *     --npm-view-json "$(cat view.json)" --npm-view-exit-code "$(cat code)"
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
  /** Raw stdout of `npm view <pkg> dist-tags.latest --json`. */
  npmViewJson: string;
  /** Exit status of that same `npm view` invocation. */
  npmViewExitCode: number;
}

export function parseCliArgs(argv: string[]): CliArgs {
  let version: string | undefined;
  let npmViewJson: string | undefined;
  let npmViewExitCode: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version") {
      version = argv[++i];
    } else if (arg === "--npm-view-json") {
      // Distinguished from "flag absent": `npm view` legitimately prints
      // nothing on some failures, and the workflow passes that through
      // verbatim. Reading "" as a missing flag would be indistinguishable
      // from a forgotten argument.
      const value = argv[++i];
      if (value === undefined) {
        throw new Error('--npm-view-json requires a value (pass "" when npm printed nothing)');
      }
      npmViewJson = value;
    } else if (arg === "--npm-view-exit-code") {
      npmViewExitCode = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (version === undefined || version === "") {
    throw new Error("--version is required");
  }
  if (npmViewJson === undefined) {
    throw new Error("--npm-view-json is required");
  }
  if (npmViewExitCode === undefined || npmViewExitCode === "") {
    throw new Error("--npm-view-exit-code is required");
  }
  if (!/^[0-9]+$/.test(npmViewExitCode)) {
    throw new Error(`--npm-view-exit-code must be a non-negative integer, got ${npmViewExitCode}`);
  }

  return { version, npmViewJson, npmViewExitCode: Number(npmViewExitCode) };
}

/**
 * The registry's current `latest` for a package, as read from `npm view`.
 *
 * `undefined` means the package has no `latest` yet — the only failure that may
 * be treated as "this publish creates it".
 */
export type RegistryLatest = string | undefined;

/**
 * Interpret `npm view <pkg> dist-tags.latest --json`.
 *
 * Why the JSON form and the exit code, rather than `|| true` over plain stdout:
 * a missing package and an unreachable registry both exit 1 with empty stdout,
 * so the plain form cannot tell "no latest yet" from "the lookup broke". Reading
 * the latter as "no latest" is fail-OPEN — it hands `latest` to whatever version
 * is publishing, which is exactly the rollback this script exists to stop. With
 * `--json`, npm reports a machine-readable `error.code`, so only a genuine
 * `E404` maps to "no latest"; anything else throws and fails the job.
 */
export function interpretNpmView(stdout: string, exitCode: number): RegistryLatest {
  const trimmed = stdout.trim();

  if (exitCode === 0) {
    // `npm view <pkg> dist-tags.latest --json` prints a JSON string, e.g. "3.1.0".
    if (trimmed === "") {
      throw new Error("npm view succeeded but printed nothing; refusing to guess the registry tag");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("npm view output is not valid JSON");
    }
    if (typeof parsed !== "string" || parsed === "") {
      throw new Error("npm view did not report a dist-tag string");
    }
    return parsed;
  }

  // Non-zero: only a package that does not exist is a benign "no latest yet".
  if (trimmed === "") {
    throw new Error(
      `npm view failed (exit ${exitCode}) without a JSON error body; ` +
        "cannot tell an unpublished package from a registry failure",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`npm view failed (exit ${exitCode}) and its output is not valid JSON`);
  }

  const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
  if (code === "E404") return undefined;

  throw new Error(
    `npm view failed (exit ${exitCode}) with error code ${typeof code === "string" ? code : "<unknown>"}; ` +
      "refusing to treat a registry failure as an absent dist-tag",
  );
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
export function resolveDistTag(version: string, registryLatest: RegistryLatest): string {
  const parsed = parseReleaseVersion(stripTagPrefix(version));
  if (!parsed) return NON_DEFAULT_DIST_TAG;

  const trimmedLatest = (registryLatest ?? "").trim();
  // A package with no latest yet: this publish creates it, so it is latest by
  // definition. Only `interpretNpmView` can produce this case, and only from a
  // confirmed E404 — never from a lookup that merely failed.
  if (trimmedLatest === "") return "latest";

  const parsedLatest = parseReleaseVersion(stripTagPrefix(trimmedLatest));
  if (!parsedLatest) return NON_DEFAULT_DIST_TAG;

  return compareReleaseVersions(parsed, parsedLatest) >= 0 ? "latest" : NON_DEFAULT_DIST_TAG;
}

function main(): void {
  const args = parseCliArgs(process.argv.slice(2));
  const registryLatest = interpretNpmView(args.npmViewJson, args.npmViewExitCode);
  const tag = resolveDistTag(args.version, registryLatest);

  if (tag !== "latest") {
    console.error(
      `::warning::publishing ${stripTagPrefix(args.version)} under the "${tag}" dist-tag: ` +
        `the registry's latest is ${registryLatest ?? "<none>"}, which this version does not supersede.`,
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
