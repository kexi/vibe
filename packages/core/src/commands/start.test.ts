import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveCopyConcurrency, startCommand } from "./start.ts";
import { createMockContext } from "../context/testing.ts";
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
      (line) => line.includes("git worktree add -b feat/base-branch") && line.includes(" main"),
    );
    expect(hasBaseCommand).toBe(true);
    expect(exitCode).toBeNull();
  });

  it("warns and ignores base when branch exists", async () => {
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

    await startCommand("feat/existing", { dryRun: true, base: "main" }, ctx);

    consoleErrorSpy.mockRestore();

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
