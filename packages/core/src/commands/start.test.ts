import { describe, it, expect, vi, afterEach } from "vitest";
import { startCommand } from "./start.ts";
import { resolveCopyConcurrency } from "../utils/copy-runner.ts";
import { createMockContext, createMockStdin } from "../context/testing.ts";
import type { RunResult } from "../runtime/types.ts";
import type { VibeConfig } from "../types/config.ts";

describe("startCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits with error when branch name is empty", async () => {
    let exitCode: number | null = null;
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
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

    await startCommand("", {}, ctx);

    consoleErrorSpy.mockRestore();

    expect(exitCode).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) => line.includes("Branch name is required"));
    expect(hasErrorMessage).toBe(true);
  });

  it("exits with error when not in a git repository", async () => {
    let exitCode: number | null = null;
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
      process: {
        run: (opts) => {
          const args = opts.args as string[];
          // Mock git rev-parse --show-toplevel failing (not in a repo)
          const isRevParse = args.includes("rev-parse") && args.includes("--show-toplevel");
          if (isRevParse) {
            return Promise.resolve({
              code: 128,
              success: false,
              stdout: new Uint8Array(),
              stderr: new TextEncoder().encode(
                "fatal: not a git repository (or any of the parent directories): .git\n",
              ),
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
        cwd: () => "/tmp/not-a-repo",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await startCommand("feat/test-branch", {}, ctx);

    consoleErrorSpy.mockRestore();

    expect(exitCode).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) => line.includes("Error:"));
    expect(hasErrorMessage).toBe(true);
  });

  it("dry-run mode does not create worktree", async () => {
    let exitCode: number | null = null;
    let worktreeCreated = false;
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
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
          // Mock git rev-parse --show-superproject-working-tree
          const isRevParseSuperproject =
            args.includes("rev-parse") && args.includes("--show-superproject-working-tree");
          if (isRevParseSuperproject) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Mock git remote get-url origin
          const isRemoteGetUrl = args.includes("remote") && args.includes("get-url");
          if (isRemoteGetUrl) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("git@github.com:kexi/vibe.git\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Mock git worktree list (no existing worktrees using this branch)
          const isWorktreeList = args.includes("worktree") && args.includes("list");
          if (isWorktreeList) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(
                "worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/main\n\n",
              ),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Mock git branch --list
          const isBranchList = args.includes("branch") && args.includes("--list");
          if (isBranchList) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Detect worktree add command
          const isWorktreeAdd = args.includes("worktree") && args.includes("add");
          if (isWorktreeAdd) {
            worktreeCreated = true;
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new Uint8Array(),
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
      fs: {
        readTextFile: () => Promise.reject(new Error("File not found")),
        stat: () => Promise.reject(new Error("Not found")),
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
      errors: {
        isNotFound: (error: unknown) =>
          error instanceof Error &&
          (error.message === "File not found" || error.message === "Not found"),
      },
    });

    await startCommand("feat/test-branch", { dryRun: true }, ctx);

    consoleErrorSpy.mockRestore();

    // In dry-run mode, worktree should NOT be created
    expect(worktreeCreated).toBe(false);
    // Dry-run output should contain [dry-run] prefix
    const hasDryRunOutput = stderrOutput.some((line) => line.includes("[dry-run]"));
    expect(hasDryRunOutput).toBe(true);
    // Exit should not have been called (normal completion)
    expect(exitCode).toBeNull();
  });

  it("dry-run uses base ref for new branch", async () => {
    let exitCode: number | null = null;
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
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
          const isRevParseVerify = args.includes("rev-parse") && args.includes("--verify");
          if (isRevParseVerify) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("abc123\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          const isWorktreeList = args.includes("worktree") && args.includes("list");
          if (isWorktreeList) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(
                "worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/main\n\n",
              ),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          const isShowRefVerify = args.includes("show-ref") && args.includes("--verify");
          if (isShowRefVerify) {
            return Promise.resolve({
              code: 1,
              success: false,
              stdout: new Uint8Array(),
              stderr: new TextEncoder().encode("fatal: bad ref\n"),
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
      fs: {
        readTextFile: () => Promise.reject(new Error("File not found")),
        stat: () => Promise.reject(new Error("Not found")),
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
      errors: {
        isNotFound: (error: unknown) =>
          error instanceof Error &&
          (error.message === "File not found" || error.message === "Not found"),
      },
    });

    await startCommand("feat/base-branch", { dryRun: true, base: "main" }, ctx);

    consoleErrorSpy.mockRestore();

    const hasBaseCommand = stderrOutput.some(
      (line) =>
        line.includes("git worktree add -b feat/base-branch") &&
        line.includes("--no-track") &&
        line.includes(" main"),
    );
    expect(hasBaseCommand).toBe(true);
    expect(exitCode).toBeNull();
  });

  it("dry-run uses --track flag when track option is true", async () => {
    let exitCode: number | null = null;
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
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
          const isRevParseVerify = args.includes("rev-parse") && args.includes("--verify");
          if (isRevParseVerify) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("abc123\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          const isWorktreeList = args.includes("worktree") && args.includes("list");
          if (isWorktreeList) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(
                "worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/main\n\n",
              ),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          const isShowRefVerify = args.includes("show-ref") && args.includes("--verify");
          if (isShowRefVerify) {
            return Promise.resolve({
              code: 1,
              success: false,
              stdout: new Uint8Array(),
              stderr: new TextEncoder().encode("fatal: bad ref\n"),
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
      fs: {
        readTextFile: () => Promise.reject(new Error("File not found")),
        stat: () => Promise.reject(new Error("Not found")),
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
      errors: {
        isNotFound: (error: unknown) =>
          error instanceof Error &&
          (error.message === "File not found" || error.message === "Not found"),
      },
    });

    await startCommand("feat/tracked-branch", { dryRun: true, base: "main", track: true }, ctx);

    consoleErrorSpy.mockRestore();

    const hasTrackCommand = stderrOutput.some(
      (line) =>
        line.includes("git worktree add -b feat/tracked-branch") &&
        line.includes("--track") &&
        !line.includes("--no-track") &&
        line.includes(" main"),
    );
    expect(hasTrackCommand).toBe(true);
    expect(exitCode).toBeNull();
  });

  it("warns and ignores base when branch exists", async () => {
    let exitCode: number | null = null;
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
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
          const isWorktreeList = args.includes("worktree") && args.includes("list");
          if (isWorktreeList) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(
                "worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/main\n\n",
              ),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          const isShowRefVerify = args.includes("show-ref") && args.includes("--verify");
          if (isShowRefVerify) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new Uint8Array(),
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
      fs: {
        readTextFile: () => Promise.reject(new Error("File not found")),
        stat: () => Promise.reject(new Error("Not found")),
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
      errors: {
        isNotFound: (error: unknown) =>
          error instanceof Error &&
          (error.message === "File not found" || error.message === "Not found"),
      },
    });

    await startCommand("feat/existing", { dryRun: true, base: "main" }, ctx);

    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();

    const hasWarning = stderrOutput.some((line) =>
      line.includes("Warning: Branch 'feat/existing' already exists; --base is ignored."),
    );
    expect(hasWarning).toBe(true);

    const baseUsed = stderrOutput.some(
      (line) => line.includes("git worktree add") && line.includes(" main"),
    );
    expect(baseUsed).toBe(false);
    expect(exitCode).toBeNull();
  });

  it("exits with error when base value looks like option", async () => {
    let exitCode: number | null = null;
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
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
          const isWorktreeList = args.includes("worktree") && args.includes("list");
          if (isWorktreeList) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(
                "worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/main\n\n",
              ),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          const isShowRefVerify = args.includes("show-ref") && args.includes("--verify");
          if (isShowRefVerify) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new Uint8Array(),
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
      fs: {
        readTextFile: () => Promise.reject(new Error("File not found")),
        stat: () => Promise.reject(new Error("Not found")),
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
      errors: {
        isNotFound: (error: unknown) =>
          error instanceof Error &&
          (error.message === "File not found" || error.message === "Not found"),
      },
    });

    await startCommand("feat/invalid-base", { dryRun: true, base: "--no-hooks" }, ctx);

    consoleErrorSpy.mockRestore();

    expect(exitCode).toBe(1);
    const hasError = stderrOutput.some((line) => line.includes("Error: --base requires a value"));
    expect(hasError).toBe(true);
  });

  it("exits with error when base ref is invalid", async () => {
    let exitCode: number | null = null;
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
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
          const isRevParseVerify = args.includes("rev-parse") && args.includes("--verify");
          if (isRevParseVerify) {
            return Promise.resolve({
              code: 1,
              success: false,
              stdout: new Uint8Array(),
              stderr: new TextEncoder().encode("fatal: bad object\n"),
            } as RunResult);
          }
          const isWorktreeList = args.includes("worktree") && args.includes("list");
          if (isWorktreeList) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(
                "worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/main\n\n",
              ),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          const isShowRefVerify = args.includes("show-ref") && args.includes("--verify");
          if (isShowRefVerify) {
            return Promise.resolve({
              code: 1,
              success: false,
              stdout: new Uint8Array(),
              stderr: new TextEncoder().encode("fatal: bad ref\n"),
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
      fs: {
        readTextFile: () => Promise.reject(new Error("File not found")),
        stat: () => Promise.reject(new Error("Not found")),
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
      errors: {
        isNotFound: (error: unknown) =>
          error instanceof Error &&
          (error.message === "File not found" || error.message === "Not found"),
      },
    });

    await startCommand("feat/invalid-base", { dryRun: true, base: "no-such-ref" }, ctx);

    consoleErrorSpy.mockRestore();

    expect(exitCode).toBe(1);
    const hasError = stderrOutput.some((line) =>
      line.includes("Error: Base 'no-such-ref' not found"),
    );
    expect(hasError).toBe(true);
  });

  it("shows error on exception", async () => {
    let exitCode: number | null = null;
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

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

    await startCommand("feat/test-branch", {}, ctx);

    consoleErrorSpy.mockRestore();

    expect(exitCode).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) => line.includes("Error:"));
    expect(hasErrorMessage).toBe(true);
  });

  it("escapes single quotes in cd output to prevent shell injection", async () => {
    const stdoutOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const ctx = createMockContext({
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
          const isRevParseSuperproject =
            args.includes("rev-parse") && args.includes("--show-superproject-working-tree");
          if (isRevParseSuperproject) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          const isRemoteGetUrl = args.includes("remote") && args.includes("get-url");
          if (isRemoteGetUrl) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode("git@github.com:kexi/vibe.git\n"),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          // Branch already used in existing worktree with single quote in path
          const isWorktreeList = args.includes("worktree") && args.includes("list");
          if (isWorktreeList) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(
                "worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
                  "worktree /tmp/it's-a-worktree\nHEAD def456\nbranch refs/heads/feat/test\n\n",
              ),
              stderr: new Uint8Array(),
            } as RunResult);
          }
          const isShowRefVerify = args.includes("show-ref") && args.includes("--verify");
          if (isShowRefVerify) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new Uint8Array(),
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
      fs: {
        readTextFile: () => Promise.reject(new Error("File not found")),
        stat: () => Promise.reject(new Error("Not found")),
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
          error instanceof Error &&
          (error.message === "File not found" || error.message === "Not found"),
      },
      io: {
        stdin: {
          // Return "Y" to confirm navigating to existing worktree
          read: (buf: Uint8Array) => {
            const data = new TextEncoder().encode("Y\n");
            buf.set(data);
            return Promise.resolve(data.length);
          },
          isTerminal: () => true,
        },
        stderr: {
          writeSync: () => 0,
          write: () => Promise.resolve(0),
          isTerminal: () => false,
        },
      },
    });

    await startCommand("feat/test", {}, ctx);

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();

    // The cd command should have escaped single quotes
    const hasSafeOutput = stdoutOutput.some((line) => line === "cd '/tmp/it'\\''s-a-worktree'");
    expect(hasSafeOutput).toBe(true);
  });
});

describe("startCommand --claude-code-worktree-hook mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper to create a mock context for claude-code-worktree-hook mode tests.
   * Simulates stdin JSON input and git commands.
   */
  function createWorktreeHookContext(options: {
    stdinData?: string;
    branchExists?: boolean;
    remoteBranchExists?: boolean;
    worktreeListOutput?: string;
    repoRoot?: string;
    repoName?: string;
    vibeTomlContent?: string;
    hookRunCwd?: string[];
  }) {
    const {
      branchExists = false,
      remoteBranchExists = false,
      repoRoot = "/tmp/mock-repo",
      repoName = "mock-repo",
      vibeTomlContent,
      hookRunCwd = [],
    } = options;

    const homePath = "/tmp/test-home";
    const settingsJsonPath = `${homePath}/.config/vibe/settings.json`;

    let exitCode: number | null = null;
    const stderrOutput: string[] = [];
    const stdoutOutput: string[] = [];

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Build worktree list output
    const worktreeListOutput =
      options.worktreeListOutput ?? `worktree ${repoRoot}\nHEAD abc123\nbranch refs/heads/main\n\n`;

    // Create stdin mock
    const stdinMock = createMockStdin(options.stdinData ?? "");

    const ctx = createMockContext({
      env: {
        get: (key: string) => {
          const isHome = key === "HOME";
          if (isHome) return homePath;
          return undefined;
        },
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
      process: {
        run: (opts) => {
          const args = opts.args as string[];

          // Track cwd of hook execution
          const isHookCommand =
            !args.includes("git") && args.length > 0 && !args[0]?.startsWith("git");
          if (isHookCommand && opts.cwd) {
            hookRunCwd.push(String(opts.cwd));
          }

          // Mock: git rev-parse --show-toplevel
          const isRevParseShowToplevel =
            args.includes("rev-parse") && args.includes("--show-toplevel");
          if (isRevParseShowToplevel) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(`${repoRoot}\n`),
              stderr: new Uint8Array(),
            } as RunResult);
          }

          // Mock: git rev-parse --show-superproject-working-tree
          const isRevParseSuperproject =
            args.includes("rev-parse") && args.includes("--show-superproject-working-tree");
          if (isRevParseSuperproject) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            } as RunResult);
          }

          // Mock: git remote get-url origin
          const isRemoteGetUrl = args.includes("remote") && args.includes("get-url");
          if (isRemoteGetUrl) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(`git@github.com:kexi/${repoName}.git\n`),
              stderr: new Uint8Array(),
            } as RunResult);
          }

          // Mock: git worktree list
          const isWorktreeList = args.includes("worktree") && args.includes("list");
          if (isWorktreeList) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(worktreeListOutput),
              stderr: new Uint8Array(),
            } as RunResult);
          }

          // Mock: git show-ref --verify (branch exists check)
          const isShowRefVerify = args.includes("show-ref") && args.includes("--verify");
          if (isShowRefVerify) {
            const refArg = args.find((a) => a.startsWith("refs/"));
            const isRemoteRef = refArg?.startsWith("refs/remotes/") ?? false;
            const exists = isRemoteRef ? remoteBranchExists : branchExists;
            return Promise.resolve({
              code: exists ? 0 : 1,
              success: exists,
              stdout: new Uint8Array(),
              stderr: exists ? new Uint8Array() : new TextEncoder().encode("fatal: bad ref\n"),
            } as RunResult);
          }

          // Mock: git branch --list
          const isBranchList = args.includes("branch") && args.includes("--list");
          if (isBranchList) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            } as RunResult);
          }

          // Mock: git worktree add (success)
          const isWorktreeAdd = args.includes("worktree") && args.includes("add");
          if (isWorktreeAdd) {
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            } as RunResult);
          }

          // Mock: git config (for getRepoInfoFromPath)
          const isConfigGet = args.includes("config") && args.includes("--get");
          if (isConfigGet) {
            return Promise.resolve({
              code: 1,
              success: false,
              stdout: new Uint8Array(),
              stderr: new TextEncoder().encode("no remote\n"),
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
      fs: {
        stat: (path) => {
          const pathStr = String(path);
          const isVibeToml = pathStr.endsWith(".vibe.toml") && !pathStr.endsWith(".local.toml");
          if (isVibeToml) {
            const hasContent = vibeTomlContent !== undefined;
            if (hasContent) {
              return Promise.resolve({
                isFile: true,
                isDirectory: false,
                isSymlink: false,
                size: 100,
                mtime: null,
                atime: null,
                birthtime: null,
                mode: null,
              });
            }
            return Promise.reject(new Error("ENOENT"));
          }
          const isLocalToml = pathStr.endsWith(".vibe.local.toml");
          if (isLocalToml) {
            return Promise.reject(new Error("ENOENT"));
          }
          return Promise.reject(new Error("Not found"));
        },
        readTextFile: (path) => {
          const pathStr = String(path);
          const isSettingsJson = pathStr === settingsJsonPath;
          if (isSettingsJson) {
            return Promise.resolve(
              JSON.stringify({
                version: 3,
                skipHashCheck: true,
                permissions: {
                  allow: [
                    {
                      repoId: { repoRoot },
                      relativePath: ".vibe.toml",
                      hashes: [],
                      skipHashCheck: true,
                    },
                  ],
                  deny: [],
                },
              }),
            );
          }
          const isVibeToml = pathStr.endsWith(".vibe.toml");
          if (isVibeToml && vibeTomlContent) {
            return Promise.resolve(vibeTomlContent);
          }
          return Promise.reject(new Error("File not found"));
        },
        exists: () => Promise.resolve(false),
        readFile: () => Promise.resolve(new Uint8Array()),
        writeTextFile: () => Promise.resolve(),
        mkdir: () => Promise.resolve(),
        remove: () => Promise.resolve(),
        rename: () => Promise.resolve(),
        lstat: () =>
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
        copyFile: () => Promise.resolve(),
        readDir: async function* () {},
        makeTempDir: () => Promise.resolve("/tmp/mock"),
        realPath: (path) => Promise.resolve(path),
      },
      control: {
        exit: ((code: number) => {
          exitCode = code;
        }) as never,
        cwd: () => repoRoot,
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
      io: {
        stdin: stdinMock,
        stderr: {
          writeSync: () => 0,
          write: () => Promise.resolve(0),
          isTerminal: () => false,
        },
      },
      errors: {
        isNotFound: (error: unknown) =>
          error instanceof Error &&
          (error.message === "File not found" ||
            error.message === "Not found" ||
            error.message === "ENOENT"),
      },
    });

    return {
      ctx,
      getExitCode: () => exitCode,
      stderrOutput,
      stdoutOutput,
      consoleErrorSpy,
      consoleLogSpy,
      consoleWarnSpy,
      hookRunCwd,
    };
  }

  it("reads branch name from stdin and outputs worktree path to stdout", async () => {
    const { ctx, getExitCode, stdoutOutput } = createWorktreeHookContext({
      stdinData: JSON.stringify({ name: "test-feature" }),
    });

    await startCommand("", { worktreeHook: true, quiet: true }, ctx);

    expect(getExitCode()).toBeNull();
    const hasWorktreePath = stdoutOutput.some((line) => line.includes("test-feature"));
    expect(hasWorktreePath).toBe(true);
  });

  it("CLI branch name takes precedence over stdin name", async () => {
    const { ctx, getExitCode, stdoutOutput } = createWorktreeHookContext({
      stdinData: JSON.stringify({ name: "stdin-name" }),
    });

    await startCommand("cli-branch", { worktreeHook: true, quiet: true }, ctx);

    expect(getExitCode()).toBeNull();
    const hasCliBranch = stdoutOutput.some((line) => line.includes("cli-branch"));
    expect(hasCliBranch).toBe(true);
    const hasStdinName = stdoutOutput.some((line) => line.includes("stdin-name"));
    expect(hasStdinName).toBe(false);
  });

  it("exits with error when no branch name from stdin or CLI", async () => {
    const { ctx, getExitCode, stderrOutput } = createWorktreeHookContext({
      stdinData: JSON.stringify({ cwd: "/tmp/project" }),
    });

    await startCommand("", { worktreeHook: true }, ctx);

    expect(getExitCode()).toBe(1);
    const hasError = stderrOutput.some((line) =>
      line.includes("--claude-code-worktree-hook requires a name"),
    );
    expect(hasError).toBe(true);
  });

  it("exits with error when stdin is empty and no CLI branch", async () => {
    const { ctx, getExitCode, stderrOutput } = createWorktreeHookContext({});

    await startCommand("", { worktreeHook: true }, ctx);

    expect(getExitCode()).toBe(1);
    const hasError = stderrOutput.some((line) =>
      line.includes("--claude-code-worktree-hook requires a name"),
    );
    expect(hasError).toBe(true);
  });

  it("outputs raw worktree path (not formatCdCommand)", async () => {
    const { ctx, stdoutOutput } = createWorktreeHookContext({
      stdinData: JSON.stringify({ name: "my-feature" }),
    });

    await startCommand("", { worktreeHook: true, quiet: true }, ctx);

    // Should NOT contain "cd" command format
    const hasCdCommand = stdoutOutput.some((line) => line.startsWith("cd "));
    expect(hasCdCommand).toBe(false);
    // Should contain a raw path
    const hasRawPath = stdoutOutput.some((line) => line.startsWith("/"));
    expect(hasRawPath).toBe(true);
  });

  it("does not output path in dry-run mode", async () => {
    const { ctx, stdoutOutput, stderrOutput } = createWorktreeHookContext({
      stdinData: JSON.stringify({ name: "dry-run-test" }),
    });

    await startCommand("", { worktreeHook: true, dryRun: true }, ctx);

    // stdout should be empty (no path output in dry-run)
    expect(stdoutOutput).toHaveLength(0);
    // stderr should have dry-run messages
    const hasDryRun = stderrOutput.some((line) => line.includes("[dry-run]"));
    expect(hasDryRun).toBe(true);
  });

  it("skips hooks when --no-hooks is specified", async () => {
    const hookRunCwd: string[] = [];
    const { ctx, getExitCode } = createWorktreeHookContext({
      stdinData: JSON.stringify({ name: "no-hooks-test" }),
      vibeTomlContent:
        '[hooks]\npre_start = ["echo pre"]\npost_start = ["echo post"]\n\n[copy]\nfiles = ["README.md"]\n',
      hookRunCwd,
    });

    await startCommand("", { worktreeHook: true, noHooks: true, quiet: true }, ctx);

    expect(getExitCode()).toBeNull();
    // No hooks should have been executed
    expect(hookRunCwd).toHaveLength(0);
  });

  it("handles branch already used in another worktree by outputting existing path", async () => {
    const existingPath = "/tmp/existing-worktree";
    const { ctx, getExitCode, stdoutOutput } = createWorktreeHookContext({
      stdinData: JSON.stringify({ name: "existing-branch" }),
      worktreeListOutput:
        `worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/main\n\n` +
        `worktree ${existingPath}\nHEAD def456\nbranch refs/heads/existing-branch\n\n`,
    });

    await startCommand("", { worktreeHook: true, quiet: true }, ctx);

    expect(getExitCode()).toBeNull();
    const hasExistingPath = stdoutOutput.some((line) => line === existingPath);
    expect(hasExistingPath).toBe(true);
  });

  it("uses existing remote branch via DWIM when local branch does not exist", async () => {
    const { ctx, getExitCode, stdoutOutput } = createWorktreeHookContext({
      stdinData: JSON.stringify({ name: "remote-only-branch" }),
      branchExists: false,
      remoteBranchExists: true,
    });

    let worktreeAddArgs: string[] = [];
    const originalRun = ctx.runtime.process.run;
    ctx.runtime.process.run = (opts) => {
      const args = opts.args as string[];
      const isWorktreeAdd = args.includes("worktree") && args.includes("add");
      if (isWorktreeAdd) {
        worktreeAddArgs = [...args];
      }
      return originalRun(opts);
    };

    await startCommand("", { worktreeHook: true, quiet: true }, ctx);

    expect(getExitCode()).toBeNull();
    // Should use `git worktree add <path> <branch>` (DWIM form, no -b flag)
    expect(worktreeAddArgs).not.toContain("-b");
    expect(worktreeAddArgs).toContain("remote-only-branch");
    const hasPath = stdoutOutput.some((line) => line.includes("remote-only-branch"));
    expect(hasPath).toBe(true);
  });

  it("reuses existing worktree when same-branch conflict at target path", async () => {
    const repoRoot = "/tmp/mock-repo";
    const worktreePath = `${repoRoot}/../mock-repo-same-branch`;
    const { ctx, getExitCode, stdoutOutput } = createWorktreeHookContext({
      stdinData: JSON.stringify({ name: "same-branch" }),
      worktreeListOutput:
        `worktree ${repoRoot}\nHEAD abc123\nbranch refs/heads/main\n\n` +
        `worktree ${worktreePath}\nHEAD def456\nbranch refs/heads/same-branch\n\n`,
      branchExists: true,
    });

    // Override process.run to track worktree commands
    const originalRun = ctx.runtime.process.run;
    let worktreeAddCalled = false;
    ctx.runtime.process.run = (opts) => {
      const args = opts.args as string[];
      const isWorktreeAdd = args.includes("worktree") && args.includes("add");
      if (isWorktreeAdd) {
        worktreeAddCalled = true;
      }
      return originalRun(opts);
    };

    await startCommand("", { worktreeHook: true, quiet: true }, ctx);

    expect(getExitCode()).toBeNull();
    // Should output the worktree path (reuse, not recreate)
    const hasPath = stdoutOutput.some((line) => line.includes("same-branch"));
    expect(hasPath).toBe(true);
    // Should NOT have called worktree add (reuse existing)
    expect(worktreeAddCalled).toBe(false);
  });

  it("handles git errors with exit code 1", async () => {
    const { ctx, getExitCode, stderrOutput } = createWorktreeHookContext({
      stdinData: JSON.stringify({ name: "error-test" }),
    });

    // Override process.run to simulate git failure
    ctx.runtime.process.run = () => Promise.reject(new Error("git command failed"));

    await startCommand("", { worktreeHook: true }, ctx);

    expect(getExitCode()).toBe(1);
    const hasError = stderrOutput.some((line) => line.includes("Error:"));
    expect(hasError).toBe(true);
  });
});

describe("resolveCopyConcurrency", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns default when no config or env", () => {
    const ctx = createMockContext({
      env: {
        get: () => undefined,
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
    });

    const result = resolveCopyConcurrency(undefined, ctx);

    expect(result).toBe(4);
  });

  it("returns config value when set", () => {
    const ctx = createMockContext({
      env: {
        get: () => undefined,
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
    });
    const config: VibeConfig = {
      copy: { concurrency: 8 },
    };

    const result = resolveCopyConcurrency(config, ctx);

    expect(result).toBe(8);
  });

  it("env var takes precedence over config", () => {
    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "16" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
    });
    const config: VibeConfig = {
      copy: { concurrency: 8 },
    };

    const result = resolveCopyConcurrency(config, ctx);

    expect(result).toBe(16);
  });

  it("env var with minimum value", () => {
    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "1" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
    });

    const result = resolveCopyConcurrency(undefined, ctx);

    expect(result).toBe(1);
  });

  it("env var with maximum value", () => {
    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "32" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
    });

    const result = resolveCopyConcurrency(undefined, ctx);

    expect(result).toBe(32);
  });

  it("invalid env var (zero) falls back to default", () => {
    const warnOutput: string[] = [];
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "0" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
    });

    const result = resolveCopyConcurrency(undefined, ctx);

    consoleWarnSpy.mockRestore();

    expect(result).toBe(4);
    const hasWarning = warnOutput.some((line) =>
      line.includes("Warning: Invalid VIBE_COPY_CONCURRENCY value '0'"),
    );
    expect(hasWarning).toBe(true);
  });

  it("invalid env var (negative) falls back to default", () => {
    const warnOutput: string[] = [];
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "-1" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
    });

    const result = resolveCopyConcurrency(undefined, ctx);

    consoleWarnSpy.mockRestore();

    expect(result).toBe(4);
    const hasWarning = warnOutput.some((line) =>
      line.includes("Warning: Invalid VIBE_COPY_CONCURRENCY value '-1'"),
    );
    expect(hasWarning).toBe(true);
  });

  it("invalid env var (above max) falls back to default", () => {
    const warnOutput: string[] = [];
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "33" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
    });

    const result = resolveCopyConcurrency(undefined, ctx);

    consoleWarnSpy.mockRestore();

    expect(result).toBe(4);
    const hasWarning = warnOutput.some((line) =>
      line.includes("Warning: Invalid VIBE_COPY_CONCURRENCY value '33'"),
    );
    expect(hasWarning).toBe(true);
  });

  it("invalid env var (non-numeric) falls back to default", () => {
    const warnOutput: string[] = [];
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "abc" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
    });

    const result = resolveCopyConcurrency(undefined, ctx);

    consoleWarnSpy.mockRestore();

    expect(result).toBe(4);
    const hasWarning = warnOutput.some((line) =>
      line.includes("Warning: Invalid VIBE_COPY_CONCURRENCY value 'abc'"),
    );
    expect(hasWarning).toBe(true);
  });

  it("invalid env var warns and uses default (not config)", () => {
    const warnOutput: string[] = [];
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "invalid" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
    });
    const config: VibeConfig = {
      copy: { concurrency: 8 },
    };

    const result = resolveCopyConcurrency(config, ctx);

    consoleWarnSpy.mockRestore();

    // Note: Invalid env var warns and falls back to DEFAULT (4), not config value
    // This is by design - we warn about the invalid env var and use default
    expect(result).toBe(4);
    const hasWarning = warnOutput.some((line) =>
      line.includes("Warning: Invalid VIBE_COPY_CONCURRENCY value 'invalid'"),
    );
    expect(hasWarning).toBe(true);
  });
});
