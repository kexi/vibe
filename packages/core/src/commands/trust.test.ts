import { describe, it, expect, vi, afterEach } from "vitest";
import { trustCommand } from "./trust.ts";
import { createMockContext } from "../context/testing.ts";
import type { FileInfo, RunResult } from "../runtime/types.ts";

describe("trustCommand", () => {
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

    await trustCommand(ctx);

    consoleErrorSpy.mockRestore();

    expect(exitCode).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) =>
      line.includes("Neither .vibe.toml nor .vibe.local.toml found"),
    );
    expect(hasErrorMessage).toBe(true);
  });

  it("reports error when trust fails", async () => {
    let exitCode: number | null = null;
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    let statCallCount = 0;
    const ctx = createMockContext({
      fs: {
        stat: () => {
          statCallCount++;
          // .vibe.toml exists
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
          // .vibe.local.toml doesn't exist
          return Promise.reject(new Error("File not found"));
        },
        readTextFile: () => Promise.resolve(""),
        readFile: () => Promise.reject(new Error("Cannot read file")),
        writeTextFile: () => Promise.resolve(),
        mkdir: () => Promise.resolve(),
      },
      process: {
        run: (opts) => {
          const args = opts.args as string[];
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
          const isRemoteGetUrl = args.includes("remote") && args.includes("get-url");
          if (isRemoteGetUrl) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("git@github.com:test/repo.git\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          } as RunResult);
        },
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
      env: {
        get: (key: string) => {
          if (key === "HOME") return "/tmp/home";
          return undefined;
        },
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
      build: {
        os: "darwin",
        arch: "aarch64",
      },
    });

    await trustCommand(ctx);

    consoleErrorSpy.mockRestore();

    // Should exit with error
    expect(exitCode).toBe(1);

    // Should show error message
    const hasFailedMessage = stderrOutput.some((line) => line.includes("Failed to trust"));
    expect(hasFailedMessage).toBe(true);
  });
});
