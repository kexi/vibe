/**
 * Ordering over the release versions this project publishes.
 *
 * Single source of truth for every "is the version this run is about to ship
 * still the newest one?" question (#616). Re-running an old release run, or a
 * re-fired `workflow_run` publish, would otherwise walk a distribution channel
 * backwards: `gh release edit --draft=false --latest` moves GitHub's latest
 * pointer, the Homebrew tap mirrors that pointer, and a bare `npm publish`
 * moves the `latest` dist-tag. None of those operations look at whether a newer
 * version already shipped, so the comparison has to happen before them.
 *
 * Why not a semver library: the only shapes this project publishes are
 * `X.Y.Z` (stable, release.yml); the beta channel that once produced
 * `X.Y.Z-beta.N` is gone, though such tags remain on GitHub and must still
 * order correctly. A full semver implementation would accept build metadata
 * and arbitrary prerelease identifiers that no gate here should have to reason
 * about, and pulling a dependency into the release path widens its supply chain
 * for an ordering that fits in a numeric compare.
 */

export interface ReleaseVersion {
  major: number;
  minor: number;
  patch: number;
  /** `undefined` for a stable version; the N of `-beta.N` otherwise. */
  beta?: number;
}

const VERSION_PATTERN = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-beta\.([0-9]+))?$/;

/**
 * Parse `X.Y.Z` or `X.Y.Z-beta.N`, returning `undefined` for anything else.
 *
 * Why not throw: the inputs are release tags and registry dist-tags, sets this
 * repository does not fully own — a hand-made tag or a legacy `-rc.1` version
 * must not fail the gate outright. Callers treat an unparseable entry as "not
 * comparable" and ignore it, which is safe because every version the workflows
 * publish is parseable by construction.
 */
export function parseReleaseVersion(version: string): ReleaseVersion | undefined {
  // Checked before the anchored regex: JavaScript's `$` matches before a
  // trailing newline, so "3.1.0\n" would otherwise parse and then be reported
  // back to the operator with an invisible line break in it.
  if (/\s/.test(version)) return undefined;

  const match = VERSION_PATTERN.exec(version);
  if (!match) return undefined;

  const [, major, minor, patch, beta] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    ...(beta === undefined ? {} : { beta: Number(beta) }),
  };
}

/** Strip a single leading `v`, so a git tag and a bare version compare alike. */
export function stripTagPrefix(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/**
 * Total order: negative when `a` precedes `b`, positive when it follows, 0 when
 * equal. A `-beta.N` precedes its own stable release, per semver's rule that a
 * prerelease sorts before the version it leads to.
 */
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  if (a.beta === undefined && b.beta === undefined) return 0;
  if (a.beta === undefined) return 1;
  if (b.beta === undefined) return -1;
  return a.beta - b.beta;
}

/** Compare two version strings, treating unparseable input as an error. */
export function compareVersionStrings(a: string, b: string): number {
  const parsedA = parseReleaseVersion(a);
  const parsedB = parseReleaseVersion(b);
  if (!parsedA) throw new Error(`unparseable version: ${JSON.stringify(a)}`);
  if (!parsedB) throw new Error(`unparseable version: ${JSON.stringify(b)}`);
  return compareReleaseVersions(parsedA, parsedB);
}

/**
 * The newest of `candidates` (tags or bare versions), or `undefined` when none
 * of them parse. Unparseable entries are skipped rather than fatal — see
 * `parseReleaseVersion`.
 */
export function newestVersion(candidates: readonly string[]): string | undefined {
  let best: { raw: string; parsed: ReleaseVersion } | undefined;

  for (const candidate of candidates) {
    const parsed = parseReleaseVersion(stripTagPrefix(candidate));
    if (!parsed) continue;
    if (!best || compareReleaseVersions(parsed, best.parsed) > 0) {
      best = { raw: stripTagPrefix(candidate), parsed };
    }
  }

  return best?.raw;
}
