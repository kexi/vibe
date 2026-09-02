/**
 * Tests for scripts/verify-release-files.ts — the pre-upload gate that decides
 * whether a release may be created, and emits the list that gets uploaded.
 *
 * What these guarantee:
 *   - every expected file must exist as a non-empty regular file before the
 *     release is created, named individually, so the #597 masking case (a
 *     missing platform binary compensated for by an unrelated extra file) is
 *     reported instead of published;
 *   - a symlink or directory at an expected path is a problem rather than
 *     something to follow (lstat, CWE-59 posture);
 *   - the license documents are looked for in the repository checkout and the
 *     binaries/.debs in the artifacts directory, in manifest order — the order
 *     the workflow uploads in;
 *   - the CLI refuses incomplete or unrecognised arguments, since a silently
 *     defaulted channel would gate against the wrong asset set.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedReleaseAssets } from "../../../scripts/release-asset-manifest";
import {
  parseCliArgs,
  resolveAssetPaths,
  findLocalAssetProblems,
} from "../../../scripts/verify-release-files";

const VERSION = "3.1.0";

let root: string;
let artifactsDir: string;
let repoRoot: string;

/** Lay out a complete, healthy stable release tree. */
async function stageCompleteRelease(): Promise<void> {
  for (const name of [
    "vibe-linux-x64",
    "vibe-linux-arm64",
    "vibe-darwin-x64",
    "vibe-darwin-arm64",
    "vibe-win32-x64",
    `vibe_${VERSION}_amd64.deb`,
    `vibe_${VERSION}_arm64.deb`,
  ]) {
    await writeFile(join(artifactsDir, name), "binary bytes");
  }
  await writeFile(join(repoRoot, "LICENSE"), "MIT");
  await writeFile(join(repoRoot, "THIRD-PARTY-LICENSES.md"), "# notices");
}

/** The gate's view of a stable release staged under the temp dirs. */
function stableEntries() {
  return resolveAssetPaths(expectedReleaseAssets("stable", VERSION), artifactsDir, repoRoot);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vibe-release-files-"));
  artifactsDir = join(root, "artifacts");
  repoRoot = join(root, "checkout");
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(repoRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveAssetPaths", () => {
  it("maps artifact assets to the artifacts dir and license documents to the checkout", () => {
    const entries = resolveAssetPaths(
      expectedReleaseAssets("stable", VERSION),
      "artifacts",
      "/repo",
    );
    expect(entries).toEqual([
      { name: "vibe-linux-x64", path: join("artifacts", "vibe-linux-x64") },
      { name: "vibe-linux-arm64", path: join("artifacts", "vibe-linux-arm64") },
      { name: "vibe-darwin-x64", path: join("artifacts", "vibe-darwin-x64") },
      { name: "vibe-darwin-arm64", path: join("artifacts", "vibe-darwin-arm64") },
      { name: "vibe-win32-x64", path: join("artifacts", "vibe-win32-x64") },
      { name: `vibe_${VERSION}_amd64.deb`, path: join("artifacts", `vibe_${VERSION}_amd64.deb`) },
      { name: `vibe_${VERSION}_arm64.deb`, path: join("artifacts", `vibe_${VERSION}_arm64.deb`) },
      { name: "LICENSE", path: join("/repo", "LICENSE") },
      { name: "THIRD-PARTY-LICENSES.md", path: join("/repo", "THIRD-PARTY-LICENSES.md") },
    ]);
  });
});

describe("findLocalAssetProblems", () => {
  it("accepts a complete release tree", async () => {
    await stageCompleteRelease();
    expect(await findLocalAssetProblems(stableEntries())).toEqual([]);
  });

  it("reports a missing binary even when an extra file makes the count add up", async () => {
    // The #597 regression: the old gate counted assets, so a stray extra file
    // could stand in for the absent win32 binary and the release published
    // without it.
    await stageCompleteRelease();
    await rm(join(artifactsDir, "vibe-win32-x64"));
    await writeFile(join(artifactsDir, "vibe_3.1.0_i386.deb"), "stray");

    const problems = await findLocalAssetProblems(stableEntries());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("missing release file: vibe-win32-x64");
  });

  it("does not object to extra files on an otherwise complete tree", async () => {
    await stageCompleteRelease();
    await writeFile(join(artifactsDir, "package.json"), "{}");
    expect(await findLocalAssetProblems(stableEntries())).toEqual([]);
  });

  it("reports a zero-byte binary, which would upload as an unusable asset", async () => {
    await stageCompleteRelease();
    await writeFile(join(artifactsDir, "vibe-darwin-arm64"), "");

    const problems = await findLocalAssetProblems(stableEntries());
    expect(problems).toEqual([
      `release file vibe-darwin-arm64 is empty: ${join(artifactsDir, "vibe-darwin-arm64")}`,
    ]);
  });

  it("reports a directory standing in for an expected file", async () => {
    await stageCompleteRelease();
    await rm(join(artifactsDir, "vibe-linux-x64"));
    await mkdir(join(artifactsDir, "vibe-linux-x64"));

    const problems = await findLocalAssetProblems(stableEntries());
    expect(problems).toEqual([
      `release file vibe-linux-x64 is not a regular file: ${join(artifactsDir, "vibe-linux-x64")}`,
    ]);
  });

  it("rejects a symlink even when it points at a valid file", async () => {
    // lstat, not stat: following the link would upload whatever it targets
    // (CWE-59) instead of the artifact the build produced.
    await stageCompleteRelease();
    await rm(join(artifactsDir, "vibe-linux-arm64"));
    await symlink(join(artifactsDir, "vibe-linux-x64"), join(artifactsDir, "vibe-linux-arm64"));

    const problems = await findLocalAssetProblems(stableEntries());
    expect(problems).toEqual([
      `release file vibe-linux-arm64 is not a regular file: ${join(artifactsDir, "vibe-linux-arm64")}`,
    ]);
  });

  it("reports a missing LICENSE against the checkout path, not the artifacts dir", async () => {
    await stageCompleteRelease();
    await rm(join(repoRoot, "LICENSE"));

    const problems = await findLocalAssetProblems(stableEntries());
    expect(problems).toEqual([
      `missing release file: LICENSE (expected at ${join(repoRoot, "LICENSE")})`,
    ]);
  });

  it("accepts a beta tree with no .deb present", async () => {
    await stageCompleteRelease();
    await rm(join(artifactsDir, `vibe_${VERSION}_amd64.deb`));
    await rm(join(artifactsDir, `vibe_${VERSION}_arm64.deb`));

    const entries = resolveAssetPaths(
      expectedReleaseAssets("beta", "3.1.0-beta.42"),
      artifactsDir,
      repoRoot,
    );
    expect(await findLocalAssetProblems(entries)).toEqual([]);
  });
});

describe("parseCliArgs", () => {
  it("parses the full flag set", () => {
    expect(
      parseCliArgs(["--channel", "stable", "--version", "3.1.0", "--artifacts-dir", "artifacts"]),
    ).toEqual({
      channel: "stable",
      version: "3.1.0",
      artifactsDir: "artifacts",
      repoRoot: ".",
    });
  });

  it("accepts an explicit --repo-root", () => {
    expect(
      parseCliArgs([
        "--channel",
        "beta",
        "--version",
        "3.1.0-beta.7",
        "--artifacts-dir",
        "artifacts",
        "--repo-root",
        "/checkout",
      ]).repoRoot,
    ).toBe("/checkout");
  });

  it("rejects a missing --version", () => {
    expect(() => parseCliArgs(["--channel", "stable", "--artifacts-dir", "artifacts"])).toThrowError(
      /--version is required/,
    );
  });

  it("rejects a missing --artifacts-dir", () => {
    expect(() => parseCliArgs(["--channel", "stable", "--version", "3.1.0"])).toThrowError(
      /--artifacts-dir is required/,
    );
  });

  it("rejects an unknown channel instead of defaulting to one", () => {
    expect(() =>
      parseCliArgs(["--channel", "nightly", "--version", "3.1.0", "--artifacts-dir", "artifacts"]),
    ).toThrowError(/--channel must be stable or beta/);
  });

  it("rejects a valueless --repo-root instead of silently using the CWD", () => {
    expect(() =>
      parseCliArgs([
        "--channel",
        "stable",
        "--version",
        "3.1.0",
        "--artifacts-dir",
        "artifacts",
        "--repo-root",
      ]),
    ).toThrowError(/--repo-root requires a value/);
  });

  it("rejects an empty --repo-root instead of silently using the CWD", () => {
    expect(() =>
      parseCliArgs([
        "--channel",
        "stable",
        "--version",
        "3.1.0",
        "--artifacts-dir",
        "artifacts",
        "--repo-root",
        "",
      ]),
    ).toThrowError(/--repo-root requires a value/);
  });

  it("rejects an unknown flag", () => {
    expect(() =>
      parseCliArgs([
        "--channel",
        "stable",
        "--version",
        "3.1.0",
        "--artifacts-dir",
        "artifacts",
        "--publish",
      ]),
    ).toThrowError(/Unknown argument: --publish/);
  });
});
