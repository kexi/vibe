/**
 * Unit tests for the @kexi/vibe launcher shim (bin/vibe.cjs).
 *
 * What these guarantee: the pure launch logic — platform→package mapping, the
 * node_modules containment guard (valid + escaping paths), the resolve-failure
 * error message, the chmod-only-when-needed rule, and faithful exit-code /
 * signal propagation — behaves correctly WITHOUT a real platform binary on disk
 * (resolve/realpath/spawn are injected).
 */

import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

// The shim is CommonJS; load it through createRequire so the ESM test file can
// consume its module.exports.
const require = createRequire(import.meta.url);
const shim = require("../bin/vibe.cjs");

describe("platformPackageName", () => {
  it("maps every supported platform/arch pair to its scoped package", () => {
    expect(shim.platformPackageName("linux", "x64")).toBe("@kexi/vibe-linux-x64");
    expect(shim.platformPackageName("linux", "arm64")).toBe("@kexi/vibe-linux-arm64");
    expect(shim.platformPackageName("darwin", "x64")).toBe("@kexi/vibe-darwin-x64");
    expect(shim.platformPackageName("darwin", "arm64")).toBe("@kexi/vibe-darwin-arm64");
    expect(shim.platformPackageName("win32", "x64")).toBe("@kexi/vibe-win32-x64");
  });

  it("returns null for unsupported platform/arch pairs", () => {
    // Windows ARM64 is not built yet — only win32-x64 ships a binary.
    expect(shim.platformPackageName("win32", "arm64")).toBeNull();
    expect(shim.platformPackageName("linux", "ia32")).toBeNull();
    expect(shim.platformPackageName("freebsd", "arm64")).toBeNull();
  });
});

describe("isWithinNodeModules (containment guard)", () => {
  it("accepts a binary inside a plain node_modules tree", () => {
    const p = path.join(path.sep, "proj", "node_modules", "@kexi", "vibe-darwin-arm64", "bin", "vibe");
    expect(shim.isWithinNodeModules(p)).toBe(true);
  });

  it("accepts a binary inside a pnpm .pnpm symlink farm (realpath form)", () => {
    // pnpm: after realpath the binary lives under .pnpm/<pkg>@<ver>/node_modules.
    const p = path.join(
      path.sep,
      "proj",
      "node_modules",
      ".pnpm",
      "@kexi+vibe-linux-x64@1.8.1",
      "node_modules",
      "@kexi",
      "vibe-linux-x64",
      "bin",
      "vibe",
    );
    expect(shim.isWithinNodeModules(p)).toBe(true);
  });

  it("rejects a binary outside any node_modules tree (escaping path)", () => {
    const p = path.join(path.sep, "tmp", "evil", "bin", "vibe");
    expect(shim.isWithinNodeModules(p)).toBe(false);
  });
});

describe("resolveBinary", () => {
  const realpath = (p: string) => p;
  const dirname = path.join(path.sep, "proj", "node_modules", "@kexi", "vibe");

  it("resolves the platform binary pinned to dirname", () => {
    const resolved = path.join(path.sep, "proj", "node_modules", "@kexi", "vibe-linux-x64", "bin", "vibe");
    const resolve = vi.fn().mockReturnValue(resolved);

    const out = shim.resolveBinary({ platform: "linux", arch: "x64", resolve, realpath, dirname });

    expect(out).toBe(resolved);
    expect(resolve).toHaveBeenCalledWith("@kexi/vibe-linux-x64/bin/vibe", { paths: [dirname] });
  });

  it("resolves the Windows binary as extensionless bin/vibe (not vibe.exe)", () => {
    // The staged Windows binary is bin/vibe (no .exe), so require.resolve — which
    // never tries a .exe suffix — must be asked for the extensionless path.
    const resolved = path.join(path.sep, "proj", "node_modules", "@kexi", "vibe-win32-x64", "bin", "vibe");
    const resolve = vi.fn().mockReturnValue(resolved);

    const out = shim.resolveBinary({ platform: "win32", arch: "x64", resolve, realpath, dirname });

    expect(out).toBe(resolved);
    expect(resolve).toHaveBeenCalledWith("@kexi/vibe-win32-x64/bin/vibe", { paths: [dirname] });
  });

  it("throws EUNSUPPORTED for an unsupported platform", () => {
    const resolve = vi.fn();
    try {
      shim.resolveBinary({ platform: "win32", arch: "arm64", resolve, realpath, dirname });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { code: string }).code).toBe("EUNSUPPORTED");
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("throws ENORESOLVE with a reinstall hint when the package is missing", () => {
    const resolve = vi.fn(() => {
      throw new Error("Cannot find module");
    });
    try {
      shim.resolveBinary({ platform: "darwin", arch: "arm64", resolve, realpath, dirname });
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as { code: string; message: string };
      expect(e.code).toBe("ENORESOLVE");
      expect(e.message).toContain("@kexi/vibe-darwin-arm64");
      expect(e.message).toContain("do not pass --no-optional");
    }
  });

  it("throws EOUTSIDE when the realpath'd binary escapes node_modules", () => {
    const resolve = vi.fn().mockReturnValue("/whatever");
    const escapingRealpath = () => path.join(path.sep, "tmp", "evil", "vibe");
    try {
      shim.resolveBinary({ platform: "linux", arch: "x64", resolve, realpath: escapingRealpath, dirname });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { code: string }).code).toBe("EOUTSIDE");
    }
  });
});

describe("ensureExecutable", () => {
  const constants = { X_OK: 1 };

  it("does nothing on win32", () => {
    const accessSync = vi.fn();
    const chmodSync = vi.fn();
    shim.ensureExecutable("C:/bin/vibe.exe", { platform: "win32", accessSync, chmodSync, constants });
    expect(accessSync).not.toHaveBeenCalled();
    expect(chmodSync).not.toHaveBeenCalled();
  });

  it("does NOT chmod when the binary is already executable", () => {
    const accessSync = vi.fn(); // no throw => already executable
    const chmodSync = vi.fn();
    shim.ensureExecutable("/bin/vibe", { platform: "linux", accessSync, chmodSync, constants });
    expect(chmodSync).not.toHaveBeenCalled();
  });

  it("chmods 0o755 only after the X_OK check fails", () => {
    const accessSync = vi.fn(() => {
      throw new Error("not executable");
    });
    const chmodSync = vi.fn();
    shim.ensureExecutable("/bin/vibe", { platform: "darwin", accessSync, chmodSync, constants });
    expect(chmodSync).toHaveBeenCalledWith("/bin/vibe", 0o755);
  });
});

describe("run (orchestration)", () => {
  const base = {
    argv: ["start", "feat"],
    platform: "linux",
    arch: "x64",
    resolve: vi.fn().mockReturnValue("/proj/node_modules/@kexi/vibe-linux-x64/bin/vibe"),
    realpath: (p: string) => p,
    dirname: "/proj/node_modules/@kexi/vibe",
    accessSync: vi.fn(),
    chmodSync: vi.fn(),
    constants: { X_OK: 1 },
  };

  it("returns the child exit status and forwards argv with no shell", () => {
    const spawn = vi.fn().mockReturnValue({ status: 0 });
    const stderr = vi.fn();
    const killProcess = vi.fn();

    const code = shim.run({ ...base, spawn, stderr, killProcess });

    expect(code).toBe(0);
    const [bin, args, opts] = spawn.mock.calls[0];
    expect(bin).toBe("/proj/node_modules/@kexi/vibe-linux-x64/bin/vibe");
    expect(args).toEqual(["start", "feat"]);
    expect(opts).toEqual({ stdio: "inherit" });
    expect(opts).not.toHaveProperty("shell");
  });

  it("returns 1 and writes to stderr when the platform package is missing", () => {
    const resolve = vi.fn(() => {
      throw new Error("Cannot find module");
    });
    const spawn = vi.fn();
    const stderr = vi.fn();

    const code = shim.run({ ...base, resolve, spawn, stderr, killProcess: vi.fn() });

    expect(code).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(stderr.mock.calls[0][0]).toContain("@kexi/vibe-linux-x64");
  });

  it("re-raises the child's terminating signal", () => {
    const spawn = vi.fn().mockReturnValue({ signal: "SIGINT" });
    const killProcess = vi.fn();

    shim.run({ ...base, spawn, stderr: vi.fn(), killProcess });

    expect(killProcess).toHaveBeenCalledWith("SIGINT");
  });

  it("returns 1 when spawn itself errors", () => {
    const spawn = vi.fn().mockReturnValue({ error: new Error("ENOENT") });
    const stderr = vi.fn();

    const code = shim.run({ ...base, spawn, stderr, killProcess: vi.fn() });

    expect(code).toBe(1);
    expect(stderr.mock.calls[0][0]).toContain("failed to launch");
  });
});
