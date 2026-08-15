/**
 * Tests for scripts/release-asset-manifest.ts — the single source of truth for
 * which assets a release must carry.
 *
 * What these guarantee:
 *   - the stable set is exactly the 5 binaries + 2 version-stamped .debs + 2
 *     license documents, and the beta set is the same minus the .debs, so a
 *     workflow that stops attaching one fails a gate instead of publishing;
 *   - each asset declares where its bytes come from (build artifacts vs the
 *     repository checkout), which is what lets the pre-upload gate look in the
 *     right place without the workflow re-stating the layout;
 *   - a version that does not match its channel's shape throws rather than
 *     producing .deb names nothing on disk matches;
 *   - no generated name contains whitespace — the workflow reads the gate's
 *     stdout with `mapfile -t`, so a newline in a name would split one asset
 *     into two upload arguments.
 */

import { describe, it, expect } from "vitest";
import {
  PLATFORM_BINARY_ASSETS,
  LICENSE_DOCUMENT_ASSETS,
  debAssetNames,
  expectedReleaseAssets,
} from "../../../scripts/release-asset-manifest";

describe("PLATFORM_BINARY_ASSETS", () => {
  it("is the five shipped per-platform binaries", () => {
    // Pinned rather than derived: this list is the distribution promise, so a
    // change to it should be a deliberate edit that shows up in review.
    expect(PLATFORM_BINARY_ASSETS).toEqual([
      "vibe-linux-x64",
      "vibe-linux-arm64",
      "vibe-darwin-x64",
      "vibe-darwin-arm64",
      "vibe-win32-x64",
    ]);
  });
});

describe("LICENSE_DOCUMENT_ASSETS", () => {
  it("is exactly the two license documents", () => {
    expect(LICENSE_DOCUMENT_ASSETS).toEqual(["LICENSE", "THIRD-PARTY-LICENSES.md"]);
  });
});

describe("debAssetNames", () => {
  it("embeds the version in both architecture names", () => {
    expect(debAssetNames("3.1.0")).toEqual(["vibe_3.1.0_amd64.deb", "vibe_3.1.0_arm64.deb"]);
  });
});

describe("expectedReleaseAssets", () => {
  it("returns the nine stable assets in upload order with their sources", () => {
    expect(expectedReleaseAssets("stable", "3.1.0")).toEqual([
      { name: "vibe-linux-x64", source: "artifacts" },
      { name: "vibe-linux-arm64", source: "artifacts" },
      { name: "vibe-darwin-x64", source: "artifacts" },
      { name: "vibe-darwin-arm64", source: "artifacts" },
      { name: "vibe-win32-x64", source: "artifacts" },
      { name: "vibe_3.1.0_amd64.deb", source: "artifacts" },
      { name: "vibe_3.1.0_arm64.deb", source: "artifacts" },
      { name: "LICENSE", source: "repo" },
      { name: "THIRD-PARTY-LICENSES.md", source: "repo" },
    ]);
  });

  it("returns the seven beta assets, with no .deb", () => {
    const assets = expectedReleaseAssets("beta", "3.1.0-beta.42");
    expect(assets.map((a) => a.name)).toEqual([
      "vibe-linux-x64",
      "vibe-linux-arm64",
      "vibe-darwin-x64",
      "vibe-darwin-arm64",
      "vibe-win32-x64",
      "LICENSE",
      "THIRD-PARTY-LICENSES.md",
    ]);
  });

  it("rejects a prerelease version on the stable channel", () => {
    // Prerelease suffixes belong to beta-release.yml; accepting one here would
    // let a beta version publish through the stable path.
    expect(() => expectedReleaseAssets("stable", "3.1.0-beta.2")).toThrowError(
      /invalid stable release version/,
    );
  });

  it("rejects a version that is not three numeric components", () => {
    expect(() => expectedReleaseAssets("stable", "3.1")).toThrowError(
      /invalid stable release version/,
    );
  });

  it("rejects shell metacharacters in a stable version", () => {
    expect(() => expectedReleaseAssets("stable", "3.1.0;rm -rf")).toThrowError(
      /whitespace|invalid stable release version/,
    );
  });

  it("rejects a trailing newline, which the anchored regex alone would accept", () => {
    // JavaScript's `$` matches before a trailing newline, so "3.1.0\n" passes
    // /^[0-9]+\.[0-9]+\.[0-9]+$/. A newline in a .deb asset name would split
    // the gate's newline-delimited upload list into two arguments.
    expect(() => expectedReleaseAssets("stable", "3.1.0\n")).toThrowError(/whitespace/);
  });

  it("rejects an empty beta version", () => {
    expect(() => expectedReleaseAssets("beta", "")).toThrowError(/invalid beta release version/);
  });

  it("rejects an embedded space in a beta version", () => {
    expect(() => expectedReleaseAssets("beta", "3.1.0 x")).toThrowError(/whitespace/);
  });

  it("rejects a command substitution as a beta version", () => {
    expect(() => expectedReleaseAssets("beta", "$(id)")).toThrowError(
      /invalid beta release version/,
    );
  });

  it("rejects an unknown channel", () => {
    expect(() =>
      // @ts-expect-error -- the channel arrives from a workflow string, so the
      // runtime guard must hold even where the type says it cannot.
      expectedReleaseAssets("nightly", "3.1.0"),
    ).toThrowError(/unknown release channel/);
  });

  it("never produces a name containing whitespace", () => {
    for (const asset of [
      ...expectedReleaseAssets("stable", "3.1.0"),
      ...expectedReleaseAssets("beta", "3.1.0-beta.42"),
    ]) {
      expect(asset.name).toMatch(/^\S+$/);
    }
  });
});
