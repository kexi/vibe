/**
 * Tests for scripts/stage-platform-package.ts — copies a built Rust binary into
 * its per-platform npm package (`packages/vibe-<plat>-<arch>/bin/vibe`) and
 * stages THIRD-PARTY-LICENSES.md beside it for publishing.
 *
 * What these guarantee:
 *   - parseArgs rejects unsupported platform/arch and unknown flags;
 *   - staging copies the binary to bin/vibe with executable (0o755) mode and
 *     copies THIRD-PARTY-LICENSES.md when present (the file glob the platform
 *     package's `files` list publishes — G-3 would ship an empty package if
 *     this regressed);
 *   - a missing license is a warning, not a hard failure (the binary still
 *     stages), and a missing source binary IS a hard failure.
 *
 * Runs against a temp root (the `root` option) so the real packages/ tree is
 * never written to.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, stagePlatformPackage } from "../../../scripts/stage-platform-package";

let root: string;

function writeBinary(name: string, content: string): string {
  const abs = join(root, name);
  writeFileSync(abs, content, "utf-8");
  return abs;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibe-stage-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseArgs", () => {
  it("parses a valid platform/arch and defaults the binary path", () => {
    const args = parseArgs(["--platform", "linux", "--arch", "x64"]);
    expect(args.platform).toBe("linux");
    expect(args.arch).toBe("x64");
    expect(args.binary).toContain("vibe");
  });

  it("accepts win32 as a supported platform", () => {
    const args = parseArgs(["--platform", "win32", "--arch", "x64"]);
    expect(args.platform).toBe("win32");
    expect(args.arch).toBe("x64");
  });

  it("rejects an unsupported platform", () => {
    expect(() => parseArgs(["--platform", "windows", "--arch", "x64"])).toThrowError(/--platform/);
  });

  it("rejects an unsupported arch", () => {
    expect(() => parseArgs(["--platform", "linux", "--arch", "ia32"])).toThrowError(/--arch/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--platform", "linux", "--arch", "x64", "--oops"])).toThrowError(
      /Unknown argument/,
    );
  });
});

describe("stagePlatformPackage", () => {
  it("copies the binary to bin/vibe (executable) and stages THIRD-PARTY-LICENSES.md", async () => {
    const binary = writeBinary("vibe-built", "BINARY-BYTES");
    writeBinary("THIRD-PARTY-LICENSES.md", "# notices");

    const dest = await stagePlatformPackage(
      { platform: "darwin", arch: "arm64", binary },
      { root },
    );

    expect(dest).toBe(join(root, "packages", "vibe-darwin-arm64", "bin", "vibe"));
    expect(readFileSync(dest, "utf-8")).toBe("BINARY-BYTES");

    // The bin must be executable so the shim can launch it without re-chmod.
    const mode = statSync(dest).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);

    // THIRD-PARTY-LICENSES.md must land in the package root (it is in `files`).
    const license = join(root, "packages", "vibe-darwin-arm64", "THIRD-PARTY-LICENSES.md");
    expect(readFileSync(license, "utf-8")).toBe("# notices");
  });

  it("stages the Windows binary as bin/vibe.exe (keeps the extension)", async () => {
    // On Windows the cargo artifact is vibe.exe and the staged name keeps the
    // .exe so Node can spawn the PE and the shim resolves bin/vibe.exe.
    const binary = writeBinary("vibe.exe", "WIN-BINARY-BYTES");

    const dest = await stagePlatformPackage(
      { platform: "win32", arch: "x64", binary },
      { root },
    );

    expect(dest).toBe(join(root, "packages", "vibe-win32-x64", "bin", "vibe.exe"));
    expect(readFileSync(dest, "utf-8")).toBe("WIN-BINARY-BYTES");
  });

  it("warns but still stages the binary when THIRD-PARTY-LICENSES.md is absent", async () => {
    const binary = writeBinary("vibe-built", "BINARY-BYTES");
    const warnings: string[] = [];

    const dest = await stagePlatformPackage(
      { platform: "linux", arch: "x64", binary },
      { root, warn: (m) => warnings.push(m) },
    );

    expect(readFileSync(dest, "utf-8")).toBe("BINARY-BYTES");
    expect(warnings.some((w) => w.includes("THIRD-PARTY-LICENSES.md not found"))).toBe(true);
  });

  it("throws when the source binary does not exist", async () => {
    await expect(
      stagePlatformPackage(
        { platform: "linux", arch: "x64", binary: join(root, "does-not-exist") },
        { root },
      ),
    ).rejects.toThrowError(/binary not found/);
  });
});
