/**
 * Tests for scripts/stage-platform-package.ts — copies a built Rust binary into
 * its per-platform npm package (`packages/vibe-<plat>-<arch>/bin/vibe`) and
 * stages LICENSE + THIRD-PARTY-LICENSES.md beside it for publishing.
 *
 * What these guarantee:
 *   - parseArgs rejects unsupported platform/arch and unknown flags;
 *   - staging copies the binary to bin/vibe with executable (0o755) mode and
 *     copies THIRD-PARTY-LICENSES.md when present (the file glob the platform
 *     package's `files` list publishes — G-3 would ship an empty package if
 *     this regressed);
 *   - staging also copies the project's own LICENSE, so the published tarball
 *     carries vibe's MIT terms (npm includes a top-level LICENSE regardless of
 *     `files`);
 *   - a missing THIRD-PARTY-LICENSES.md is a warning, not a hard failure (it is
 *     a build product, and the tarball verifier is the release gate), whereas a
 *     missing root LICENSE or source binary IS a hard failure — LICENSE is a
 *     committed file, so its absence means a broken checkout, and the tarball
 *     verifier does not run on the Windows CI leg to catch it.
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
  it("copies the binary to bin/vibe (executable) and stages both license files", async () => {
    const binary = writeBinary("vibe-built", "BINARY-BYTES");
    writeBinary("THIRD-PARTY-LICENSES.md", "# notices");
    writeBinary("LICENSE", "MIT License\n");

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
    const pkgDir = join(root, "packages", "vibe-darwin-arm64");
    expect(readFileSync(join(pkgDir, "THIRD-PARTY-LICENSES.md"), "utf-8")).toBe("# notices");

    // vibe's own LICENSE must ship too, so the tarball states its MIT terms.
    expect(readFileSync(join(pkgDir, "LICENSE"), "utf-8")).toBe("MIT License\n");
  });

  it("stages LICENSE for the Windows package as well", async () => {
    const binary = writeBinary("vibe.exe", "WIN-BINARY-BYTES");
    writeBinary("LICENSE", "MIT License\n");

    await stagePlatformPackage({ platform: "win32", arch: "x64", binary }, { root });

    const license = join(root, "packages", "vibe-win32-x64", "LICENSE");
    expect(readFileSync(license, "utf-8")).toBe("MIT License\n");
  });

  it("stages the Windows binary as bin/vibe.exe (keeps the extension)", async () => {
    // On Windows the cargo artifact is vibe.exe and the staged name keeps the
    // .exe so Node can spawn the PE and the shim resolves bin/vibe.exe.
    const binary = writeBinary("vibe.exe", "WIN-BINARY-BYTES");
    writeBinary("LICENSE", "MIT License\n");

    const dest = await stagePlatformPackage(
      { platform: "win32", arch: "x64", binary },
      { root },
    );

    expect(dest).toBe(join(root, "packages", "vibe-win32-x64", "bin", "vibe.exe"));
    expect(readFileSync(dest, "utf-8")).toBe("WIN-BINARY-BYTES");
  });

  it("warns but still stages the binary when THIRD-PARTY-LICENSES.md is absent", async () => {
    // The notice file is a build product: not having generated it yet is a
    // recoverable state, and verify-platform-tarball.ts is the release gate.
    const binary = writeBinary("vibe-built", "BINARY-BYTES");
    writeBinary("LICENSE", "MIT License\n");
    const warnings: string[] = [];

    const dest = await stagePlatformPackage(
      { platform: "linux", arch: "x64", binary },
      { root, warn: (m) => warnings.push(m) },
    );

    expect(readFileSync(dest, "utf-8")).toBe("BINARY-BYTES");
    expect(warnings.some((w) => w.includes("THIRD-PARTY-LICENSES.md not found"))).toBe(true);
  });

  it("throws when the root LICENSE is absent (a committed file: a warn would let a license-less package ship)", async () => {
    const binary = writeBinary("vibe-built", "BINARY-BYTES");
    writeBinary("THIRD-PARTY-LICENSES.md", "# notices");

    await expect(
      stagePlatformPackage({ platform: "linux", arch: "x64", binary }, { root }),
    ).rejects.toThrowError(/LICENSE not found/);
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
