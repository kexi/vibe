/**
 * Tests for scripts/verify-platform-tarball.ts (G-3) — asserts that a published
 * package's planned npm tarball includes everything its expectation requires:
 * for platform packages bin/vibe (executable), THIRD-PARTY-LICENSES.md AND the
 * project's own LICENSE; for the shim (packages/npm) the committed launcher and
 * LICENSE. A wrong `files` glob or a skipped staging step cannot publish an
 * empty / non-runnable / license-less package.
 *
 * Only the pure validation (expectationFor + findTarballProblems) is
 * unit-tested here; the `npm pack --dry-run --json` invocation that feeds it is
 * exercised by the CI publish/verify step (it needs a staged binary on disk).
 */

import { describe, it, expect } from "vitest";
import {
  findTarballProblems,
  binaryPathFor,
  expectationFor,
} from "../../../scripts/verify-platform-tarball";

const execMode = 0o755;
const plainMode = 0o644;

describe("binaryPathFor", () => {
  it("uses bin/vibe.exe for the win32 package and bin/vibe elsewhere", () => {
    expect(binaryPathFor("packages/vibe-win32-x64")).toBe("bin/vibe.exe");
    expect(binaryPathFor("packages/vibe-linux-x64")).toBe("bin/vibe");
    expect(binaryPathFor("packages/vibe-darwin-arm64")).toBe("bin/vibe");
  });
});

describe("expectationFor", () => {
  it("requires binary + both license files (binary executable) for unix platform packages", () => {
    expect(expectationFor("packages/vibe-linux-x64")).toEqual({
      requiredFiles: ["bin/vibe", "THIRD-PARTY-LICENSES.md", "LICENSE"],
      executableEntry: "bin/vibe",
    });
  });

  it("skips the exec-bit requirement for the win32 package (.exe modes are meaningless)", () => {
    expect(expectationFor("packages/vibe-win32-x64")).toEqual({
      requiredFiles: ["bin/vibe.exe", "THIRD-PARTY-LICENSES.md", "LICENSE"],
      executableEntry: undefined,
    });
  });

  it("requires the committed launcher + LICENSE (no notices, no exec bit) for the shim", () => {
    // The shim ships no statically-linked code, so no THIRD-PARTY-LICENSES.md;
    // its launcher is committed 0644 and npm wires the bin at install time.
    expect(expectationFor("packages/npm")).toEqual({
      requiredFiles: ["bin/vibe.cjs", "LICENSE"],
    });
  });
});

describe("findTarballProblems", () => {
  const platformExpectation = expectationFor("packages/vibe-linux-x64");

  it("returns no problems when bin/vibe (executable) and both licenses are present", () => {
    const problems = findTarballProblems(
      [
        { path: "bin/vibe", size: 100, mode: execMode },
        { path: "THIRD-PARTY-LICENSES.md", size: 10, mode: plainMode },
        { path: "LICENSE", size: 10, mode: plainMode },
        { path: "package.json", size: 50, mode: plainMode },
      ],
      platformExpectation,
    );
    expect(problems).toEqual([]);
  });

  it("returns no problems for a Windows tarball with bin/vibe.exe (no exec-bit check)", () => {
    const problems = findTarballProblems(
      [
        // Windows tarball entries carry no meaningful unix mode bits.
        { path: "bin/vibe.exe", size: 100, mode: plainMode },
        { path: "THIRD-PARTY-LICENSES.md", size: 10, mode: plainMode },
        { path: "LICENSE", size: 10, mode: plainMode },
        { path: "package.json", size: 50, mode: plainMode },
      ],
      expectationFor("packages/vibe-win32-x64"),
    );
    expect(problems).toEqual([]);
  });

  it("returns no problems for a shim tarball with the launcher and LICENSE", () => {
    const problems = findTarballProblems(
      [
        // The committed launcher carries no exec bit; npm wires it at install.
        { path: "bin/vibe.cjs", size: 100, mode: plainMode },
        { path: "LICENSE", size: 10, mode: plainMode },
        { path: "README.md", size: 20, mode: plainMode },
        { path: "package.json", size: 50, mode: plainMode },
      ],
      expectationFor("packages/npm"),
    );
    expect(problems).toEqual([]);
  });

  it("flags a missing binary", () => {
    const problems = findTarballProblems(
      [
        { path: "THIRD-PARTY-LICENSES.md", size: 10, mode: plainMode },
        { path: "LICENSE", size: 10, mode: plainMode },
        { path: "package.json", size: 50, mode: plainMode },
      ],
      platformExpectation,
    );
    expect(problems.some((p) => p.includes("bin/vibe"))).toBe(true);
  });

  it("flags a missing THIRD-PARTY-LICENSES.md", () => {
    const problems = findTarballProblems(
      [
        { path: "bin/vibe", size: 100, mode: execMode },
        { path: "LICENSE", size: 10, mode: plainMode },
        { path: "package.json", size: 50, mode: plainMode },
      ],
      platformExpectation,
    );
    expect(problems.some((p) => p.includes("THIRD-PARTY-LICENSES.md"))).toBe(true);
  });

  it("flags a missing LICENSE (vibe's own terms must ship in the tarball)", () => {
    const problems = findTarballProblems(
      [
        { path: "bin/vibe", size: 100, mode: execMode },
        { path: "THIRD-PARTY-LICENSES.md", size: 10, mode: plainMode },
        { path: "package.json", size: 50, mode: plainMode },
      ],
      platformExpectation,
    );
    expect(problems).toEqual(["missing required file: LICENSE"]);
  });

  it("flags a shim tarball whose LICENSE staging did not run", () => {
    const problems = findTarballProblems(
      [
        { path: "bin/vibe.cjs", size: 100, mode: plainMode },
        { path: "README.md", size: 20, mode: plainMode },
        { path: "package.json", size: 50, mode: plainMode },
      ],
      expectationFor("packages/npm"),
    );
    expect(problems).toEqual(["missing required file: LICENSE"]);
  });

  it("flags a non-executable unix binary", () => {
    const problems = findTarballProblems(
      [
        { path: "bin/vibe", size: 100, mode: plainMode },
        { path: "THIRD-PARTY-LICENSES.md", size: 10, mode: plainMode },
        { path: "LICENSE", size: 10, mode: plainMode },
      ],
      platformExpectation,
    );
    expect(problems.some((p) => p.includes("not executable"))).toBe(true);
  });

  it("reports every problem at once (empty tarball)", () => {
    const problems = findTarballProblems(
      [{ path: "package.json", size: 50, mode: plainMode }],
      platformExpectation,
    );
    // Binary + both license files missing.
    expect(problems.length).toBe(3);
  });
});
