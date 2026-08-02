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
 *   - an asset that exists in name only — zero bytes, or still uploading — is
 *     reported as a problem, since gh creates the record before the bytes land;
 *   - a release carrying extra assets (binaries, .debs) still passes, so the
 *     check does not have to be edited every time the artifact set changes.
 */

import { describe, it, expect } from "vitest";
import {
  REQUIRED_ASSETS,
  parseAssets,
  findAssetProblems,
} from "../../../scripts/verify-release-assets";

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
    const raw = JSON.stringify([{ name: "LICENSE" }]);
    expect(parseAssets(raw)).toEqual([{ name: "LICENSE", size: undefined, state: undefined }]);
  });

  it("ignores fields it does not check", () => {
    const raw = JSON.stringify({ assets: [{ name: "LICENSE", url: "https://example.invalid" }] });
    expect(parseAssets(raw)[0].name).toBe("LICENSE");
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

  it("rejects an asset whose upload has not finished", () => {
    const assets = FULL_RELEASE.map((a) =>
      a.name === "THIRD-PARTY-LICENSES.md" ? { ...a, state: "starter" } : a,
    );
    expect(findAssetProblems(assets)).toEqual([
      "release asset THIRD-PARTY-LICENSES.md is in state 'starter', expected 'uploaded'",
    ]);
  });

  it("does not require size or state when gh omits them", () => {
    expect(
      findAssetProblems([{ name: "LICENSE" }, { name: "THIRD-PARTY-LICENSES.md" }]),
    ).toEqual([]);
  });

  it("is not fooled by a similarly named asset", () => {
    const assets = [
      { name: "LICENSE.md", size: 10, state: "uploaded" },
      { name: "THIRD-PARTY-LICENSES.md", size: 10, state: "uploaded" },
    ];
    expect(findAssetProblems(assets)).toEqual(["missing required release asset: LICENSE"]);
  });
});
