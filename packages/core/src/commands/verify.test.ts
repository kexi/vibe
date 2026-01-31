import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyCommand } from "./verify.ts";
import { createMockContext } from "../context/testing.ts";
import type { FileInfo, RunResult } from "../runtime/types.ts";

describe("verifyCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits with code 1 when no config files exist", async () => {
    let exitCode: number | null = null;
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
      fs: {
        stat: () => Promise.reject(new Error("File not found")),
      },
      process: {
        run: () =>
          Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode("/tmp/mock-repo\n"),
            stderr: new Uint8Array(),
          } as RunResult),
      },
      control: {
        exit: ((code: number) => {
          exitCode = code;
        }) as never,
        cwd: () => "/tmp/mock-repo",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await verifyCommand(ctx);

    consoleErrorSpy.mockRestore();

    expect(exitCode).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) =>
      line.includes("Neither .vibe.toml nor .vibe.local.toml found"),
    );
    expect(hasErrorMessage).toBe(true);
  });

  it("shows file path when config file exists", async () => {
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    let statCallCount = 0;
    const ctx = createMockContext({
      fs: {
        stat: (_path: string | URL) => {
          statCallCount++;
          // First call is for .vibe.toml - let it succeed
          const isVibeToml = statCallCount === 1;
          if (isVibeToml) {
            return Promise.resolve({
              isFile: true,
              isDirectory: false,
              isSymlink: false,
              size: 100,
              mtime: null,
              atime: null,
              birthtime: null,
              mode: null,
            } as FileInfo);
          }
          // Second call is for .vibe.local.toml - not found
          return Promise.reject(new Error("File not found"));
        },
        readTextFile: (path: string | URL) => {
          // Settings file should return NotFound
          const pathStr = typeof path === "string" ? path : path.toString();
          const isSettingsFile = pathStr.includes("settings.json");
          if (isSettingsFile) {
            return Promise.reject(new Error("File not found"));
          }
          return Promise.resolve("");
        },
      },
      process: {
        run: (opts) => {
          const args = opts.args as string[];
          // Mock git rev-parse --show-toplevel
          const isRevParseShowToplevel =
            args.includes("rev-parse") && args.includes("--show-toplevel");
          if (isRevParseShowToplevel) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("/tmp/mock-repo\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Mock git remote get-url origin (fail - local repo)
          const isRemoteGetUrl = args.includes("remote") && args.includes("get-url");
          if (isRemoteGetUrl) {
            return Promise.resolve({
              code: 1,
              success: false,
              stdout: new Uint8Array(),
              stderr: new TextEncoder().encode("fatal: not a git repository"),
            } as RunResult);
          }
          // Default mock for other git commands
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          } as RunResult);
        },
      },
      control: {
        exit: (() => {}) as never,
        cwd: () => "/tmp/mock-repo",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
      env: {
        get: (key: string) => {
          if (key === "HOME") return "/tmp/home";
          return undefined;
        },
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
      errors: {
        isNotFound: (error: unknown) =>
          error instanceof Error && error.message === "File not found",
      },
    });

    await verifyCommand(ctx);

    consoleErrorSpy.mockRestore();

    // Should show verification header
    const hasHeader = stderrOutput.some((line) => line.includes("Vibe Configuration Verification"));
    expect(hasHeader).toBe(true);

    // Should show file path
    const hasFilePath = stderrOutput.some((line) => line.includes("File: .vibe.toml"));
    expect(hasFilePath).toBe(true);
  });
});
