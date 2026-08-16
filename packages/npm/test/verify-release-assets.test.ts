/**
 * Tests for scripts/verify-release-assets.ts — the guard that a published
 * GitHub Release actually carries LICENSE and THIRD-PARTY-LICENSES.md.
 *
 * Those two assets are inert: drop them and every download still works, while
 * the release ships a statically linked binary with no statement of its terms
 * and none of its crates' required notices. The workflows' asset-count
 * assertions cannot catch it — they count without naming. What these guarantee:
 *   - the required set is exactly the two license documents, so a rename in the
 *     workflow that silently stops attaching one fails here;
 *   - `gh release view --json assets` output parses in both the wrapped and
 *     bare-array shapes, and malformed input throws instead of being read as an
 *     empty release that trivially passes;
 *   - an asset that exists in name only — zero bytes, still uploading, or with
 *     the metadata absent altogether — is reported as a problem, since gh
 *     creates the record before the bytes land and always sends size/state, so
 *     "cannot tell" must fail rather than pass a release gate;
 *   - in the default mode a release carrying extra assets (binaries, .debs)
 *     still passes, so the check does not have to be edited every time the
 *     artifact set changes;
 *   - in --channel mode the published asset-name set must EQUAL the manifest,
 *     so a missing platform binary can no longer be masked by an unrelated
 *     extra file the way the old asset-count assertion allowed (#597).
 */

import { describe, it, expect } from "vitest";
import { expectedReleaseAssets } from "../../../scripts/release-asset-manifest";
import {
  REQUIRED_ASSETS,
  parseAssets,
  findAssetProblems,
  findUnexpectedAssets,
  parseCliOptions,
} from "../../../scripts/verify-release-assets";

const VERSION = "3.0.0";
const STABLE_NAMES = expectedReleaseAssets("stable", VERSION).map((a) => a.name);

/** The asset set a healthy stable release publishes. */
const FULL_RELEASE = [
  { name: "vibe-linux-x64", size: 5_000_000, state: "uploaded" },
  { name: "vibe-linux-arm64", size: 5_000_000, state: "uploaded" },
  { name: "vibe-darwin-x64", size: 5_000_000, state: "uploaded" },
  { name: "vibe-darwin-arm64", size: 5_000_000, state: "uploaded" },
  { name: "vibe-win32-x64", size: 5_000_000, state: "uploaded" },
  { name: "vibe_3.0.0_amd64.deb", size: 2_000_000, state: "uploaded" },
  { name: "vibe_3.0.0_arm64.deb", size: 2_000_000, state: "uploaded" },
  { name: "LICENSE", size: 1_100, state: "uploaded" },
  { name: "THIRD-PARTY-LICENSES.md", size: 200_000, state: "uploaded" },
];

describe("REQUIRED_ASSETS", () => {
  it("is exactly the two license documents", () => {
    // Pinned rather than inferred: this list IS the compliance requirement, so
    // a change to it should be a deliberate edit that shows up in review.
    expect(REQUIRED_ASSETS).toEqual(["LICENSE", "THIRD-PARTY-LICENSES.md"]);
  });
});

describe("parseAssets", () => {
  it("reads the wrapper object gh emits for --json assets", () => {
    const raw = JSON.stringify({ assets: [{ name: "LICENSE", size: 10, state: "uploaded" }] });
    expect(parseAssets(raw)).toEqual([{ name: "LICENSE", size: 10, state: "uploaded" }]);
  });

  it("reads a bare array, as produced by --jq .assets", () => {
    const raw = JSON.stringify([{ name: "LICENSE", size: 10, state: "uploaded" }]);
    expect(parseAssets(raw)).toEqual([{ name: "LICENSE", size: 10, state: "uploaded" }]);
  });

  it("ignores fields it does not check", () => {
    const raw = JSON.stringify({
      assets: [{ name: "LICENSE", size: 10, state: "uploaded", url: "https://example.invalid" }],
    });
    expect(parseAssets(raw)[0].name).toBe("LICENSE");
  });

  it("narrows absent or wrong-typed metadata to undefined for the checker to report", () => {
    // Not thrown on: only required assets matter, so a malformed entry for some
    // unrelated binary must not abort the license-document check. The undefined
    // then surfaces as a named problem in findAssetProblems.
    const raw = JSON.stringify({ assets: [{ name: "LICENSE", size: "10", state: 7 }] });
    expect(parseAssets(raw)).toEqual([{ name: "LICENSE", size: undefined, state: undefined }]);
  });

  it("throws on malformed JSON rather than reading it as an empty release", () => {
    // An empty asset list would make findAssetProblems report the files as
    // missing, but a throw names the real fault instead of a phantom one.
    expect(() => parseAssets("not json")).toThrowError(/not valid JSON/);
  });

  it("throws when the payload has no assets array", () => {
    expect(() => parseAssets(JSON.stringify({ tagName: "v3.0.0" }))).toThrowError(
      /no 'assets' array/,
    );
  });

  it("throws when an asset entry has no name", () => {
    expect(() => parseAssets(JSON.stringify({ assets: [{ size: 1 }] }))).toThrowError(
      /asset #0 has no name/,
    );
  });
});

describe("findAssetProblems", () => {
  it("accepts a complete release", () => {
    expect(findAssetProblems(FULL_RELEASE)).toEqual([]);
  });

  it("accepts a release with only the required assets", () => {
    expect(
      findAssetProblems([
        { name: "LICENSE", size: 1, state: "uploaded" },
        { name: "THIRD-PARTY-LICENSES.md", size: 1, state: "uploaded" },
      ]),
    ).toEqual([]);
  });

  it("reports a missing LICENSE", () => {
    const assets = FULL_RELEASE.filter((a) => a.name !== "LICENSE");
    expect(findAssetProblems(assets)).toEqual(["missing required release asset: LICENSE"]);
  });

  it("reports a missing THIRD-PARTY-LICENSES.md", () => {
    const assets = FULL_RELEASE.filter((a) => a.name !== "THIRD-PARTY-LICENSES.md");
    expect(findAssetProblems(assets)).toEqual([
      "missing required release asset: THIRD-PARTY-LICENSES.md",
    ]);
  });

  it("reports both when the release carries binaries only", () => {
    // The exact shape of the pre-existing workflow: seven binaries/.debs and no
    // license documents, which every asset-count check would have accepted.
    const assets = FULL_RELEASE.filter((a) => !REQUIRED_ASSETS.includes(a.name));
    expect(findAssetProblems(assets)).toEqual([
      "missing required release asset: LICENSE",
      "missing required release asset: THIRD-PARTY-LICENSES.md",
    ]);
  });

  it("rejects an asset that exists in name only", () => {
    const assets = FULL_RELEASE.map((a) => (a.name === "LICENSE" ? { ...a, size: 0 } : a));
    expect(findAssetProblems(assets)).toEqual(["release asset LICENSE is empty (0 bytes)"]);
  });

  it("rejects a negative size", () => {
    const assets = FULL_RELEASE.map((a) => (a.name === "LICENSE" ? { ...a, size: -1 } : a));
    expect(findAssetProblems(assets)).toEqual(["release asset LICENSE is empty (-1 bytes)"]);
  });

  it("rejects an asset whose upload has not finished", () => {
    const assets = FULL_RELEASE.map((a) =>
      a.name === "THIRD-PARTY-LICENSES.md" ? { ...a, state: "starter" } : a,
    );
    expect(findAssetProblems(assets)).toEqual([
      "release asset THIRD-PARTY-LICENSES.md is in state 'starter', expected 'uploaded'",
    ]);
  });

  it("reports absent metadata instead of passing the asset", () => {
    // gh always sends size and state, so a listing without them is a payload
    // this script does not understand — not a lenient older format. Passing it
    // would make the one case where verification is impossible always succeed.
    expect(findAssetProblems([{ name: "LICENSE" }, { name: "THIRD-PARTY-LICENSES.md" }])).toEqual([
      "release asset LICENSE reports no size",
      "release asset LICENSE reports no upload state",
      "release asset THIRD-PARTY-LICENSES.md reports no size",
      "release asset THIRD-PARTY-LICENSES.md reports no upload state",
    ]);
  });

  it("reports a missing size independently of a valid state", () => {
    const assets = FULL_RELEASE.map((a) =>
      a.name === "LICENSE" ? { name: a.name, state: "uploaded" } : a,
    );
    expect(findAssetProblems(assets)).toEqual(["release asset LICENSE reports no size"]);
  });

  it("reports a missing state independently of a valid size", () => {
    const assets = FULL_RELEASE.map((a) => (a.name === "LICENSE" ? { name: a.name, size: 10 } : a));
    expect(findAssetProblems(assets)).toEqual(["release asset LICENSE reports no upload state"]);
  });

  it("ignores absent metadata on assets that are not required", () => {
    // The binaries are self-describing; only the license documents are gated.
    const assets = [
      { name: "vibe-linux-x64" },
      { name: "LICENSE", size: 1, state: "uploaded" },
      { name: "THIRD-PARTY-LICENSES.md", size: 1, state: "uploaded" },
    ];
    expect(findAssetProblems(assets)).toEqual([]);
  });

  it("is not fooled by a similarly named asset", () => {
    const assets = [
      { name: "LICENSE.md", size: 10, state: "uploaded" },
      { name: "THIRD-PARTY-LICENSES.md", size: 10, state: "uploaded" },
    ];
    expect(findAssetProblems(assets)).toEqual(["missing required release asset: LICENSE"]);
  });
});

describe("findAssetProblems in full-set (--channel) mode", () => {
  it("accepts the exact stable set", () => {
    expect(findAssetProblems(FULL_RELEASE, STABLE_NAMES)).toEqual([]);
  });

  it("accepts the exact beta set of seven", () => {
    const betaNames = expectedReleaseAssets("beta", "3.0.0-beta.9").map((a) => a.name);
    const beta = FULL_RELEASE.filter((a) => !a.name.endsWith(".deb"));
    expect(findAssetProblems(beta, betaNames)).toEqual([]);
    expect(findUnexpectedAssets(beta, betaNames)).toEqual([]);
  });

  it("reports the missing binary and the stray that kept the count at nine", () => {
    // Exactly the #597 scenario: the win32 upload failed, an unrelated file
    // took its place, and the old `[ "${#ASSETS[@]}" -ne 9 ]` check passed.
    const assets = FULL_RELEASE.map((a) =>
      a.name === "vibe-win32-x64" ? { ...a, name: "vibe_3.0.0_i386.deb" } : a,
    );
    expect(assets).toHaveLength(9);
    expect(findAssetProblems(assets, STABLE_NAMES)).toEqual([
      "missing required release asset: vibe-win32-x64",
    ]);
    expect(findUnexpectedAssets(assets, STABLE_NAMES)).toEqual([
      "unexpected release asset: vibe_3.0.0_i386.deb",
    ]);
  });

  it("guards the size of a binary, not just of the license documents", () => {
    const assets = FULL_RELEASE.map((a) => (a.name === "vibe-darwin-arm64" ? { ...a, size: 0 } : a));
    expect(findAssetProblems(assets, STABLE_NAMES)).toEqual([
      "release asset vibe-darwin-arm64 is empty (0 bytes)",
    ]);
  });

  it("guards the upload state of a .deb", () => {
    const assets = FULL_RELEASE.map((a) =>
      a.name === "vibe_3.0.0_amd64.deb" ? { ...a, state: "starter" } : a,
    );
    expect(findAssetProblems(assets, STABLE_NAMES)).toEqual([
      "release asset vibe_3.0.0_amd64.deb is in state 'starter', expected 'uploaded'",
    ]);
  });

  it("rejects a .deb named for a different version", () => {
    const assets = FULL_RELEASE.map((a) =>
      a.name === "vibe_3.0.0_arm64.deb" ? { ...a, name: "vibe_2.9.9_arm64.deb" } : a,
    );
    expect(findUnexpectedAssets(assets, STABLE_NAMES)).toEqual([
      "unexpected release asset: vibe_2.9.9_arm64.deb",
    ]);
  });
});

describe("findUnexpectedAssets", () => {
  it("accepts a release whose assets are exactly the expected set", () => {
    expect(findUnexpectedAssets(FULL_RELEASE, STABLE_NAMES)).toEqual([]);
  });

  it("names every asset outside the expected set", () => {
    const assets = [...FULL_RELEASE, { name: "package.json", size: 10, state: "uploaded" }];
    expect(findUnexpectedAssets(assets, STABLE_NAMES)).toEqual([
      "unexpected release asset: package.json",
    ]);
  });
});

describe("parseCliOptions", () => {
  it("defaults to the license-documents-only mode with no arguments", () => {
    expect(parseCliOptions([])).toEqual({});
  });

  it("reads a positional listing file", () => {
    expect(parseCliOptions(["assets.json"])).toEqual({ file: "assets.json" });
  });

  it("reads the channel/version pair", () => {
    expect(parseCliOptions(["--channel", "stable", "--version", "3.1.0"])).toEqual({
      channel: "stable",
      version: "3.1.0",
    });
  });

  it("rejects --channel without --version", () => {
    // Accepting it would silently fall back to the weaker license-only gate.
    expect(() => parseCliOptions(["--channel", "stable"])).toThrowError(/must be given together/);
  });

  it("rejects --version without --channel", () => {
    expect(() => parseCliOptions(["--version", "3.1.0"])).toThrowError(/must be given together/);
  });

  it("rejects a valueless --version instead of degrading to the license-only gate", () => {
    // A trailing --version leaves version undefined, which the pair check reads
    // as "neither flag given" — so without an explicit rejection the caller
    // gets the weak default mode while believing it asked for full-set mode.
    expect(() => parseCliOptions(["--version"])).toThrowError(/--version requires a value/);
    expect(() => parseCliOptions(["--channel", "stable", "--version"])).toThrowError(
      /--version requires a value/,
    );
  });

  it("rejects an unknown channel", () => {
    expect(() => parseCliOptions(["--channel", "nightly", "--version", "3.1.0"])).toThrowError(
      /--channel must be stable or beta/,
    );
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCliOptions(["--strict"])).toThrowError(/Unknown argument: --strict/);
  });
});
