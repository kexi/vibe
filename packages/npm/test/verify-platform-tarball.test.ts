/**
 * Tests for scripts/verify-platform-tarball.ts (G-3) — asserts that a platform
 * package's planned npm tarball includes bin/vibe (executable) AND
 * THIRD-PARTY-LICENSES.md, so a wrong `files` glob or a skipped staging step
 * cannot publish an empty / non-runnable package.
 *
 * Only the pure validation (findTarballProblems) is unit-tested here; the
 * `npm pack --dry-run --json` invocation that feeds it is exercised by the CI
 * publish/verify step (it needs a staged binary on disk).
 */

import { describe, it, expect } from "vitest";
import { findTarballProblems, binaryPathFor } from "../../../scripts/verify-platform-tarball";

const execMode = 0o755;
const plainMode = 0o644;

describe("binaryPathFor", () => {
  it("uses bin/vibe.exe for the win32 package and bin/vibe elsewhere", () => {
    expect(binaryPathFor("packages/vibe-win32-x64")).toBe("bin/vibe.exe");
    expect(binaryPathFor("packages/vibe-linux-x64")).toBe("bin/vibe");
    expect(binaryPathFor("packages/vibe-darwin-arm64")).toBe("bin/vibe");
  });
});

describe("findTarballProblems", () => {
  it("returns no problems when bin/vibe (executable) and the license are present", () => {
    const problems = findTarballProblems(
      [
        { path: "bin/vibe", size: 100, mode: execMode },
        { path: "THIRD-PARTY-LICENSES.md", size: 10, mode: plainMode },
        { path: "package.json", size: 50, mode: plainMode },
      ],
      "bin/vibe",
    );
    expect(problems).toEqual([]);
  });

  it("returns no problems for a Windows tarball with bin/vibe.exe (no exec-bit check)", () => {
    const problems = findTarballProblems(
      [
        // Windows tarball entries carry no meaningful unix mode bits.
        { path: "bin/vibe.exe", size: 100, mode: plainMode },
        { path: "THIRD-PARTY-LICENSES.md", size: 10, mode: plainMode },
        { path: "package.json", size: 50, mode: plainMode },
      ],
      "bin/vibe.exe",
    );
    expect(problems).toEqual([]);
  });

  it("flags a missing binary", () => {
    const problems = findTarballProblems(
      [
        { path: "THIRD-PARTY-LICENSES.md", size: 10, mode: plainMode },
        { path: "package.json", size: 50, mode: plainMode },
      ],
      "bin/vibe",
    );
    expect(problems.some((p) => p.includes("bin/vibe"))).toBe(true);
  });

  it("flags a missing THIRD-PARTY-LICENSES.md", () => {
    const problems = findTarballProblems(
      [
        { path: "bin/vibe", size: 100, mode: execMode },
        { path: "package.json", size: 50, mode: plainMode },
      ],
      "bin/vibe",
    );
    expect(problems.some((p) => p.includes("THIRD-PARTY-LICENSES.md"))).toBe(true);
  });

  it("flags a non-executable unix binary", () => {
    const problems = findTarballProblems(
      [
        { path: "bin/vibe", size: 100, mode: plainMode },
        { path: "THIRD-PARTY-LICENSES.md", size: 10, mode: plainMode },
      ],
      "bin/vibe",
    );
    expect(problems.some((p) => p.includes("not executable"))).toBe(true);
  });

  it("reports every problem at once (empty tarball)", () => {
    const problems = findTarballProblems(
      [{ path: "package.json", size: 50, mode: plainMode }],
      "bin/vibe",
    );
    // Both required files missing.
    expect(problems.length).toBe(2);
  });
});
