/**
 * The exact set of assets a GitHub Release must carry, per channel.
 *
 * Single source of truth shared by the pre-upload gate (verify-release-files.ts,
 * which also emits the upload list) and the post-create gate
 * (verify-release-assets.ts in --channel mode). Before #597 each workflow
 * asserted an asset COUNT, so a missing platform binary could be masked by an
 * unrelated extra file (4 binaries + 3 .debs + 2 licenses still totals 9).
 * Naming every expected asset in one place makes that arithmetic impossible and
 * keeps the two gates from drifting apart.
 *
 * Invariant relied on downstream: no returned name contains whitespace. The
 * workflow reads the gate's stdout with `mapfile -t`, so a name carrying a
 * newline would split into two upload arguments; the version validation below
 * therefore rejects whitespace outright rather than trusting the anchored
 * regex, whose `$` also matches before a trailing newline in JavaScript.
 */

export type ReleaseChannel = "stable" | "beta";

/**
 * Where the asset's bytes come from: the downloaded build artifacts directory,
 * or the repository checkout (the license documents, which are committed files
 * taken from the release commit rather than from any build).
 */
export type AssetSource = "artifacts" | "repo";

export interface PlannedAsset {
  name: string;
  source: AssetSource;
}

/** The five per-platform binaries every channel ships, by exact asset name. */
export const PLATFORM_BINARY_ASSETS: readonly string[] = [
  "vibe-linux-x64",
  "vibe-linux-arm64",
  "vibe-darwin-x64",
  "vibe-darwin-arm64",
  "vibe-win32-x64",
];

/** Assets a release must carry beyond its binaries, by exact name. */
export const LICENSE_DOCUMENT_ASSETS: readonly string[] = ["LICENSE", "THIRD-PARTY-LICENSES.md"];

const STABLE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const BETA_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;

/**
 * The two Debian packages, whose names embed the version. Stable only: the beta
 * channel publishes no .deb.
 */
export function debAssetNames(version: string): string[] {
  return [`vibe_${version}_amd64.deb`, `vibe_${version}_arm64.deb`];
}

function assertVersion(channel: ReleaseChannel, version: string): void {
  // Checked before the anchored regex: in JavaScript `$` matches before a
  // trailing newline, so "3.1.0\n" would otherwise pass and inject a newline
  // into a .deb asset name — breaking the one-name-per-line protocol the
  // workflow's `mapfile` depends on.
  if (/\s/.test(version)) {
    throw new Error(`release version contains whitespace: ${JSON.stringify(version)}`);
  }

  const pattern = channel === "stable" ? STABLE_VERSION : BETA_VERSION;
  if (!pattern.test(version)) {
    throw new Error(`invalid ${channel} release version: ${JSON.stringify(version)}`);
  }
}

/**
 * The complete, ordered asset set for a release. Pure so both gates and their
 * tests can name the same set without a release to point at.
 *
 * Throws on an unknown channel or a version that does not match the channel's
 * shape: a bad version would silently produce .deb names nothing on disk
 * matches, turning the gate's "missing asset" report into a red herring.
 */
export function expectedReleaseAssets(channel: ReleaseChannel, version: string): PlannedAsset[] {
  if (channel !== "stable" && channel !== "beta") {
    throw new Error(`unknown release channel: ${JSON.stringify(channel)}`);
  }
  assertVersion(channel, version);

  const assets: PlannedAsset[] = PLATFORM_BINARY_ASSETS.map((name) => ({
    name,
    source: "artifacts" as const,
  }));

  if (channel === "stable") {
    for (const name of debAssetNames(version)) {
      assets.push({ name, source: "artifacts" });
    }
  }

  for (const name of LICENSE_DOCUMENT_ASSETS) {
    assets.push({ name, source: "repo" });
  }

  return assets;
}
