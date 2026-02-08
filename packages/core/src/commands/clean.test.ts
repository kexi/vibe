import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanCommand } from "./clean.ts";
import { createMockContext } from "../context/testing.ts";
import type { RunResult } from "../runtime/types.ts";

describe("cleanCommand", () => {
  let stderrOutput: string[];
  let stdoutOutput: string[];
  let originalError: typeof console.error;
  let originalLog: typeof console.log;

  beforeEach(() => {
    stderrOutput = [];
    stdoutOutput = [];
    originalError = console.error;
    originalLog = console.log;
    console.error = vi.fn((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });
    console.log = vi.fn((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    console.error = originalError;
    console.log = originalLog;
  });

  it("exits with error when run from main worktree", async () => {
    let exitCode: number | null = null;

    const ctx = createMockContext({
      process: {
        run: (opts) => {
          const args = opts.args as string[];
          // Mock git rev-parse --show-toplevel (repo root)
          if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("/tmp/mock-repo\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Mock git worktree list to identify main worktree
          if (args.includes("worktree") && args.includes("list")) {
            // When --porcelain, shows main worktree first
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(
                "worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/main\n\n",
              ),
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
        cwd: () => "/tmp/mock-repo", // Same as main worktree
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await cleanCommand({}, ctx);

    expect(exitCode).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) =>
      line.includes("Cannot clean main worktree"),
    );
    expect(hasErrorMessage).toBe(true);
  });

  it("shows error on exception", async () => {
    let exitCode: number | null = null;

    const ctx = createMockContext({
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

    await cleanCommand({}, ctx);

    expect(exitCode).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) => line.includes("Error:"));
    expect(hasErrorMessage).toBe(true);
  });

  it("exits gracefully when worktree already removed", async () => {
    const ctx = createMockContext({
      process: {
        run: (opts) => {
          const args = opts.args as string[];
          // Mock git rev-parse --show-toplevel (repo root)
          if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("/tmp/worktree\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Mock git worktree list - return main worktree only (current worktree already removed)
          if (args.includes("worktree") && args.includes("list")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(
                "worktree /tmp/main-repo\nHEAD abc123\nbranch refs/heads/main\n\n",
              ),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Mock git rev-parse --git-common-dir for main worktree path
          if (args.includes("rev-parse") && args.includes("--git-common-dir")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("/tmp/main-repo/.git\n"),
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
        exit: (() => {}) as never,
        cwd: () => "/tmp/worktree", // Different from main worktree
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await cleanCommand({}, ctx);

    // Should output cd command and "already removed" message
    const hasCdCommand = stdoutOutput.some((line) => line.includes("cd '"));
    expect(hasCdCommand).toBe(true);
  });

  it("escapes single quotes in cd output to prevent shell injection", async () => {
    const ctx = createMockContext({
      process: {
        run: (opts) => {
          const args = opts.args as string[];
          // Mock git rev-parse --show-toplevel (repo root)
          if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("/tmp/worktree\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Mock git worktree list - main worktree has single quote in path
          if (args.includes("worktree") && args.includes("list")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(
                "worktree /tmp/it's-a-repo\nHEAD abc123\nbranch refs/heads/main\n\n",
              ),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Mock git rev-parse --git-common-dir for main worktree path
          if (args.includes("rev-parse") && args.includes("--git-common-dir")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("/tmp/it's-a-repo/.git\n"),
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
        exit: (() => {}) as never,
        cwd: () => "/tmp/worktree",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await cleanCommand({}, ctx);

    // The cd command should have escaped single quotes
    const hasSafeOutput = stdoutOutput.some((line) => line === "cd '/tmp/it'\\''s-a-repo'");
    expect(hasSafeOutput).toBe(true);
  });

  it("shows actionable error when main worktree is deleted", async () => {
    let exitCode: number | null = null;

    const ctx = createMockContext({
      fs: {
        stat: () =>
          Promise.resolve({
            isFile: true,
            isDirectory: false,
            isSymlink: false,
            size: 0,
            mtime: null,
            atime: null,
            birthtime: null,
            mode: null,
          }),
        readTextFile: () =>
          Promise.resolve("gitdir: /tmp/deleted-main/.git/worktrees/feature-branch\n"),
        exists: () => Promise.resolve(false),
      },
      control: {
        exit: ((code: number) => {
          exitCode = code;
        }) as never,
        cwd: () => "/tmp/worktrees/feature-branch",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await cleanCommand({}, ctx);

    expect(exitCode).toBe(1);

    const errorOutput = stderrOutput.join("\n");
    expect(errorOutput).toContain("main worktree appears to have been deleted");
    expect(errorOutput).toContain("rm -rf");
    expect(errorOutput).toContain("git worktree prune");
  });
});
