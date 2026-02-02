import { describe, it, expect, vi, afterEach } from "vitest";
import { untrustCommand } from "./untrust.ts";
import { createMockContext } from "../context/testing.ts";
import type { RunResult } from "../runtime/types.ts";

describe("untrustCommand", () => {
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

    await untrustCommand(ctx);

    consoleErrorSpy.mockRestore();

    expect(exitCode).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) =>
      line.includes("Neither .vibe.toml nor .vibe.local.toml found"),
    );
    expect(hasErrorMessage).toBe(true);
  });

  it("shows error on exception", async () => {
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
        run: () => Promise.reject(new Error("git command failed")),
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

    await untrustCommand(ctx);

    consoleErrorSpy.mockRestore();

    expect(exitCode).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) => line.includes("Error:"));
    expect(hasErrorMessage).toBe(true);
  });
});
