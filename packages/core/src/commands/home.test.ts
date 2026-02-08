import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { homeCommand } from "./home.ts";
import { createMockContext } from "../context/testing.ts";
import type { RunResult } from "../runtime/types.ts";

describe("homeCommand", () => {
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

  it("outputs cd command when run from secondary worktree", async () => {
    const ctx = createMockContext({
      process: {
        run: (opts) => {
          const args = opts.args as string[];
          // Mock git rev-parse --is-inside-work-tree
          if (args.includes("rev-parse") && args.includes("--is-inside-work-tree")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("true\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Mock git rev-parse --show-toplevel (repo root)
          if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("/tmp/worktree\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Mock git worktree list to identify secondary worktree
          if (args.includes("worktree") && args.includes("list")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(
                "worktree /tmp/main-repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
                  "worktree /tmp/worktree\nHEAD def456\nbranch refs/heads/feat/test\n\n",
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
        exit: (() => {}) as never,
        cwd: () => "/tmp/worktree",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await homeCommand({}, ctx);

    const hasCdCommand = stdoutOutput.some((line) => line.includes("cd '/tmp/main-repo'"));
    expect(hasCdCommand).toBe(true);
  });

  it("shows info message when already in main worktree", async () => {
    let exitCode: number | null = null;

    const ctx = createMockContext({
      process: {
        run: (opts) => {
          const args = opts.args as string[];
          // Mock git rev-parse --is-inside-work-tree
          if (args.includes("rev-parse") && args.includes("--is-inside-work-tree")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("true\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Mock git rev-parse --show-toplevel (repo root)
          if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("/tmp/main-repo\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Mock git worktree list - only main worktree
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
        cwd: () => "/tmp/main-repo",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await homeCommand({}, ctx);

    expect(exitCode).toBeNull();
    const hasInfoMessage = stderrOutput.some((line) =>
      line.includes("Already in the main worktree"),
    );
    expect(hasInfoMessage).toBe(true);
    const hasCdCommand = stdoutOutput.some((line) => line.includes("cd '"));
    expect(hasCdCommand).toBe(false);
  });

  it("exits with error when not inside a git repository", async () => {
    let exitCode: number | null = null;

    const ctx = createMockContext({
      process: {
        run: () =>
          Promise.resolve({
            code: 128,
            success: false,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode("fatal: not a git repository\n"),
          } as RunResult),
      },
      control: {
        exit: ((code: number) => {
          exitCode = code;
        }) as never,
        cwd: () => "/tmp/not-a-repo",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await homeCommand({}, ctx);

    expect(exitCode).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) =>
      line.includes("Not inside a git repository"),
    );
    expect(hasErrorMessage).toBe(true);
  });

  it("exits with error on git exception", async () => {
    let exitCode: number | null = null;

    const ctx = createMockContext({
      process: {
        run: (opts) => {
          const args = opts.args as string[];
          // Mock git rev-parse --is-inside-work-tree succeeds
          if (args.includes("rev-parse") && args.includes("--is-inside-work-tree")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("true\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // All other git commands fail
          return Promise.reject(new Error("git command failed"));
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
    });

    await homeCommand({}, ctx);

    expect(exitCode).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) => line.includes("Error:"));
    expect(hasErrorMessage).toBe(true);
  });

  it("escapes single quotes in path to prevent shell injection", async () => {
    const ctx = createMockContext({
      process: {
        run: (opts) => {
          const args = opts.args as string[];
          if (args.includes("rev-parse") && args.includes("--is-inside-work-tree")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("true\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("/tmp/worktree\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          if (args.includes("worktree") && args.includes("list")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(
                "worktree /tmp/it's-a-repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
                  "worktree /tmp/worktree\nHEAD def456\nbranch refs/heads/feat/test\n\n",
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
        exit: (() => {}) as never,
        cwd: () => "/tmp/worktree",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await homeCommand({}, ctx);

    const hasCdCommand = stdoutOutput.some((line) => line === "cd '/tmp/it'\\''s-a-repo'");
    expect(hasCdCommand).toBe(true);
  });

  it("suppresses info message with quiet option", async () => {
    const ctx = createMockContext({
      process: {
        run: (opts) => {
          const args = opts.args as string[];
          if (args.includes("rev-parse") && args.includes("--is-inside-work-tree")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("true\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("/tmp/main-repo\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
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
        cwd: () => "/tmp/main-repo",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await homeCommand({ quiet: true }, ctx);

    const hasInfoMessage = stderrOutput.some((line) =>
      line.includes("Already in the main worktree"),
    );
    expect(hasInfoMessage).toBe(false);
  });
});
