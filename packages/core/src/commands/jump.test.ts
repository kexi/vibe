import { describe, it, expect, vi, afterEach } from "vitest";
import { jumpCommand } from "./jump.ts";
import { createMockContext } from "../context/testing.ts";
import type { RunResult } from "../runtime/types.ts";

/**
 * Helper to create worktree list porcelain output
 */
function worktreeListOutput(worktrees: { path: string; branch: string }[]): string {
  return worktrees
    .map((w) => `worktree ${w.path}\nHEAD abc123\nbranch refs/heads/${w.branch}\n`)
    .join("\n");
}

/**
 * Helper to create a mock context with worktree list
 */
function createWorktreeContext(
  worktrees: { path: string; branch: string }[],
  overrides: {
    exitCode?: { value: number | null };
    stdinResponses?: string[];
  } = {},
) {
  const exitCode = overrides.exitCode ?? { value: null };
  let stdinIndex = 0;
  const stdinResponses = overrides.stdinResponses ?? [];

  return createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        const isWorktreeList = args.includes("worktree") && args.includes("list");
        if (isWorktreeList) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode(worktreeListOutput(worktrees)),
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
        exitCode.value = code;
      }) as never,
      cwd: () => "/tmp/mock-repo",
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
    io: {
      stdin: {
        read: (buf: Uint8Array) => {
          const response = stdinResponses[stdinIndex++];
          if (response === undefined) {
            return Promise.resolve(null);
          }
          const encoded = new TextEncoder().encode(response);
          buf.set(encoded);
          return Promise.resolve(encoded.length);
        },
        isTerminal: () => true,
      },
      stderr: {
        writeSync: () => 0,
        write: () => Promise.resolve(0),
        isTerminal: () => false,
      },
    },
    env: {
      get: (key: string) => {
        if (key === "VIBE_FORCE_INTERACTIVE") return "1";
        return undefined;
      },
      set: () => {},
      delete: () => {},
      toObject: () => ({}),
    },
  });
}

describe("jumpCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits with error when branch name is empty", async () => {
    const exitCode = { value: null as number | null };
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
      control: {
        exit: ((code: number) => {
          exitCode.value = code;
        }) as never,
        cwd: () => "/tmp/mock-repo",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await jumpCommand("", {}, ctx);

    consoleErrorSpy.mockRestore();

    expect(exitCode.value).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) => line.includes("Branch name is required"));
    expect(hasErrorMessage).toBe(true);
  });

  it("outputs cd when exact match found", async () => {
    const stdoutOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-login", branch: "feat/login" },
      ],
      { exitCode },
    );

    await jumpCommand("feat/login", {}, ctx);

    consoleLogSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    const hasCdOutput = stdoutOutput.some((line) =>
      line.includes("cd '/tmp/mock-repo-feat-login'"),
    );
    expect(hasCdOutput).toBe(true);
  });

  it("outputs cd when single partial match found", async () => {
    const stdoutOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-login", branch: "feat/login-page" },
      ],
      { exitCode },
    );

    await jumpCommand("login", {}, ctx);

    consoleLogSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    const hasCdOutput = stdoutOutput.some((line) =>
      line.includes("cd '/tmp/mock-repo-feat-login'"),
    );
    expect(hasCdOutput).toBe(true);
  });

  it("shows select prompt when multiple partial matches found", async () => {
    const stdoutOutput: string[] = [];
    const stderrOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-auth-login", branch: "feat/auth-login" },
        { path: "/tmp/mock-repo-feat-auth-logout", branch: "feat/auth-logout" },
      ],
      { exitCode, stdinResponses: ["1"] },
    );

    await jumpCommand("auth", {}, ctx);

    consoleLogSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    const hasCdOutput = stdoutOutput.some((line) =>
      line.includes("cd '/tmp/mock-repo-feat-auth-login'"),
    );
    expect(hasCdOutput).toBe(true);
  });

  it("cancels when user selects Cancel from multiple matches", async () => {
    const stdoutOutput: string[] = [];
    const stderrOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-auth-login", branch: "feat/auth-login" },
        { path: "/tmp/mock-repo-feat-auth-logout", branch: "feat/auth-logout" },
      ],
      { exitCode, stdinResponses: ["3"] }, // 3 = Cancel (2 matches + Cancel)
    );

    await jumpCommand("auth", {}, ctx);

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    const hasCdOutput = stdoutOutput.some((line) => line.includes("cd "));
    expect(hasCdOutput).toBe(false);
    const hasCancelled = stderrOutput.some((line) => line.includes("Cancelled"));
    expect(hasCancelled).toBe(true);
  });

  it("delegates to startCommand when no match and user confirms", async () => {
    const stdoutOutput: string[] = [];
    const stderrOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext([{ path: "/tmp/mock-repo", branch: "main" }], {
      exitCode,
      stdinResponses: ["Y"],
    });

    // startCommand will be called, which triggers git commands
    // Since our mock returns success for all git commands, it won't fully work
    // but we can verify it doesn't error out or cancel
    await jumpCommand("feat/nonexistent", {}, ctx);

    consoleLogSpy.mockRestore();

    // Should not have printed "Cancelled"
    const hasCancelled = stderrOutput.some((line) => line.includes("Cancelled"));
    expect(hasCancelled).toBe(false);
  });

  it("cancels when no match and user declines", async () => {
    const stderrOutput: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext([{ path: "/tmp/mock-repo", branch: "main" }], {
      exitCode,
      stdinResponses: ["n"],
    });

    await jumpCommand("feat/nonexistent", {}, ctx);

    consoleErrorSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    const hasCancelled = stderrOutput.some((line) => line.includes("Cancelled"));
    expect(hasCancelled).toBe(true);
  });

  it("trims whitespace from branch name", async () => {
    const stdoutOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-login", branch: "feat/login" },
      ],
      { exitCode },
    );

    await jumpCommand("  feat/login  ", {}, ctx);

    consoleLogSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    const hasCdOutput = stdoutOutput.some((line) =>
      line.includes("cd '/tmp/mock-repo-feat-login'"),
    );
    expect(hasCdOutput).toBe(true);
  });

  it("treats whitespace-only branch name as empty", async () => {
    const exitCode = { value: null as number | null };
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const ctx = createMockContext({
      control: {
        exit: ((code: number) => {
          exitCode.value = code;
        }) as never,
        cwd: () => "/tmp/mock-repo",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await jumpCommand("   ", {}, ctx);

    consoleErrorSpy.mockRestore();

    expect(exitCode.value).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) => line.includes("Branch name is required"));
    expect(hasErrorMessage).toBe(true);
  });

  it("matches case-insensitively for exact match", async () => {
    const stdoutOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-login", branch: "feat/login" },
      ],
      { exitCode },
    );

    await jumpCommand("FEAT/LOGIN", {}, ctx);

    consoleLogSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    const hasCdOutput = stdoutOutput.some((line) =>
      line.includes("cd '/tmp/mock-repo-feat-login'"),
    );
    expect(hasCdOutput).toBe(true);
  });

  it("matches case-insensitively for partial match", async () => {
    const stdoutOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-login", branch: "feat/login-page" },
      ],
      { exitCode },
    );

    await jumpCommand("LOGIN", {}, ctx);

    consoleLogSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    const hasCdOutput = stdoutOutput.some((line) =>
      line.includes("cd '/tmp/mock-repo-feat-login'"),
    );
    expect(hasCdOutput).toBe(true);
  });

  it("prefers word boundary match over substring match", async () => {
    const stdoutOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-login", branch: "feat/login" },
        { path: "/tmp/mock-repo-feat-blogin", branch: "feat/blogin" },
      ],
      { exitCode },
    );

    // "login" should match only "feat/login" (word boundary after /)
    // and NOT "feat/blogin" (substring but not at word boundary)
    await jumpCommand("login", {}, ctx);

    consoleLogSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    const hasCdOutput = stdoutOutput.some((line) =>
      line.includes("cd '/tmp/mock-repo-feat-login'"),
    );
    expect(hasCdOutput).toBe(true);
  });

  it("matches at hyphen word boundary", async () => {
    const stdoutOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-auth-login", branch: "feat/auth-login" },
      ],
      { exitCode },
    );

    // "login" appears after "-" in "feat/auth-login"
    await jumpCommand("login", {}, ctx);

    consoleLogSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    const hasCdOutput = stdoutOutput.some((line) =>
      line.includes("cd '/tmp/mock-repo-feat-auth-login'"),
    );
    expect(hasCdOutput).toBe(true);
  });

  it("falls back to substring match when no word boundary match", async () => {
    const stdoutOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-blogin", branch: "feat/blogin" },
      ],
      { exitCode },
    );

    // "login" is a substring of "blogin" but not at a word boundary
    // Should still match via substring fallback
    await jumpCommand("login", {}, ctx);

    consoleLogSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    const hasCdOutput = stdoutOutput.some((line) =>
      line.includes("cd '/tmp/mock-repo-feat-blogin'"),
    );
    expect(hasCdOutput).toBe(true);
  });

  it("fuzzy matches when no substring match exists (feli → feat/login)", async () => {
    const stdoutOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-login", branch: "feat/login" },
      ],
      { exitCode },
    );

    await jumpCommand("feli", {}, ctx);

    consoleLogSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    const hasCdOutput = stdoutOutput.some((line) =>
      line.includes("cd '/tmp/mock-repo-feat-login'"),
    );
    expect(hasCdOutput).toBe(true);
  });

  it("shows select prompt for multiple fuzzy matches sorted by score", async () => {
    const stdoutOutput: string[] = [];
    const stderrOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-login", branch: "feat/login" },
        { path: "/tmp/mock-repo-fix-loading", branch: "fix/loading" },
      ],
      { exitCode, stdinResponses: ["1"] },
    );

    // "flog" should fuzzy match both "feat/login" and "fix/loading"
    await jumpCommand("flog", {}, ctx);

    consoleLogSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    // Should have selected the first option
    const hasCdOutput = stdoutOutput.some((line) => line.includes("cd "));
    expect(hasCdOutput).toBe(true);
  });

  it("skips fuzzy match when search is shorter than minimum length", async () => {
    const stderrOutput: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-login", branch: "feat/login" },
      ],
      { exitCode, stdinResponses: ["n"] },
    );

    // "fl" is only 2 characters, below FUZZY_MATCH_MIN_LENGTH (3)
    // No substring match for "fl" either, so it should go to "No match found"
    await jumpCommand("fl", {}, ctx);

    consoleErrorSpy.mockRestore();

    // Should have asked about creating a worktree (no match found path)
    const hasNoMatchMessage = stderrOutput.some((line) => line.includes("No worktree found"));
    expect(hasNoMatchMessage).toBe(true);
  });

  it("prefers substring match over fuzzy match", async () => {
    const stdoutOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-login", branch: "feat/login" },
      ],
      { exitCode },
    );

    // "login" is a substring of "feat/login", so substring match should fire first
    await jumpCommand("login", {}, ctx);

    consoleLogSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    const hasCdOutput = stdoutOutput.some((line) =>
      line.includes("cd '/tmp/mock-repo-feat-login'"),
    );
    expect(hasCdOutput).toBe(true);
  });

  it("records MRU entry on exact match", async () => {
    const stdoutOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    let mruWritten = "";
    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-login", branch: "feat/login" },
      ],
      { exitCode },
    );

    // Override env to provide HOME for MRU file path
    ctx.runtime.env.get = (key: string) => {
      if (key === "HOME") return "/tmp";
      if (key === "VIBE_FORCE_INTERACTIVE") return "1";
      return undefined;
    };

    // Override fs to capture MRU writes
    const originalReadTextFile = ctx.runtime.fs.readTextFile;
    ctx.runtime.fs.readTextFile = (path: string) => {
      if (path.includes("mru.json")) {
        return Promise.resolve("[]");
      }
      return originalReadTextFile(path);
    };
    ctx.runtime.fs.writeTextFile = (_path: string, content: string) => {
      if (_path.includes("mru.json")) {
        mruWritten = content;
      }
      return Promise.resolve();
    };
    ctx.runtime.fs.mkdir = () => Promise.resolve();
    ctx.runtime.fs.rename = () => Promise.resolve();

    await jumpCommand("feat/login", {}, ctx);

    consoleLogSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    const hasCdOutput = stdoutOutput.some((line) =>
      line.includes("cd '/tmp/mock-repo-feat-login'"),
    );
    expect(hasCdOutput).toBe(true);

    // Verify MRU was recorded
    const hasMruWrite = mruWritten.length > 0;
    expect(hasMruWrite).toBe(true);
    if (hasMruWrite) {
      const mruData = JSON.parse(mruWritten);
      expect(mruData[0].branch).toBe("feat/login");
      expect(mruData[0].path).toBe("/tmp/mock-repo-feat-login");
    }
  });

  it("sorts multiple matches by MRU order", async () => {
    const stdoutOutput: string[] = [];
    const stderrOutput: string[] = [];
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

    // MRU data: auth-logout was used more recently than auth-login
    const mruData = [
      {
        branch: "feat/auth-logout",
        path: "/tmp/mock-repo-feat-auth-logout",
        timestamp: 2000,
      },
      {
        branch: "feat/auth-login",
        path: "/tmp/mock-repo-feat-auth-login",
        timestamp: 1000,
      },
    ];

    const exitCode = { value: null as number | null };
    const ctx = createWorktreeContext(
      [
        { path: "/tmp/mock-repo", branch: "main" },
        { path: "/tmp/mock-repo-feat-auth-login", branch: "feat/auth-login" },
        { path: "/tmp/mock-repo-feat-auth-logout", branch: "feat/auth-logout" },
      ],
      { exitCode, stdinResponses: ["1"] }, // Select first option (should be auth-logout due to MRU)
    );

    // Override env to provide HOME for MRU file path
    ctx.runtime.env.get = (key: string) => {
      if (key === "HOME") return "/tmp";
      if (key === "VIBE_FORCE_INTERACTIVE") return "1";
      return undefined;
    };

    // Override readTextFile to return MRU data for mru.json
    const originalReadTextFile = ctx.runtime.fs.readTextFile;
    ctx.runtime.fs.readTextFile = (path: string) => {
      if (path.includes("mru.json")) {
        return Promise.resolve(JSON.stringify(mruData));
      }
      return originalReadTextFile(path);
    };
    ctx.runtime.fs.mkdir = () => Promise.resolve();
    ctx.runtime.fs.rename = () => Promise.resolve();

    await jumpCommand("auth", {}, ctx);

    consoleLogSpy.mockRestore();

    expect(exitCode.value).toBeNull();
    // First option should be auth-logout (MRU timestamp 2000 > 1000)
    const hasCdOutput = stdoutOutput.some((line) =>
      line.includes("cd '/tmp/mock-repo-feat-auth-logout'"),
    );
    expect(hasCdOutput).toBe(true);
  });

  it("shows error on exception", async () => {
    const exitCode = { value: null as number | null };
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
          exitCode.value = code;
        }) as never,
        cwd: () => "/tmp/mock-repo",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await jumpCommand("feat/test-branch", {}, ctx);

    consoleErrorSpy.mockRestore();

    expect(exitCode.value).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) => line.includes("Error:"));
    expect(hasErrorMessage).toBe(true);
  });
});
