import { describe, it, expect, vi, afterEach } from "vitest";
import { copyCommand } from "./copy.ts";
import { createMockContext } from "../context/testing.ts";
import type { RunResult } from "../runtime/types.ts";

/**
 * Helper to create a mock context for copy command tests.
 * Simulates git worktree list with a main worktree and an optional secondary worktree.
 */
function createCopyTestContext(options: {
  cwd?: string;
  mainWorktreePath?: string;
  isMainWorktree?: boolean;
  vibeTomlContent?: string;
  vibeTomlExists?: boolean;
  exitCodes?: number[];
}) {
  const {
    cwd = "/tmp/worktree",
    mainWorktreePath = "/tmp/main-repo",
    isMainWorktree = false,
    vibeTomlContent,
    vibeTomlExists = vibeTomlContent !== undefined,
  } = options;

  let exitCode: number | null = null;
  const stderrOutput: string[] = [];

  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderrOutput.push(args.map(String).join(" "));
  });
  const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  // Build worktree list output
  const worktreeListOutput = isMainWorktree
    ? `worktree ${cwd}\nbranch refs/heads/main\n`
    : `worktree ${mainWorktreePath}\nbranch refs/heads/main\n\nworktree ${cwd}\nbranch refs/heads/feat/test\n`;

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];

        // Mock: git rev-parse --show-toplevel
        const isRevParse = args.includes("rev-parse") && args.includes("--show-toplevel");
        if (isRevParse) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode(`${cwd}\n`),
            stderr: new Uint8Array(),
          } as RunResult);
        }

        // Mock: git worktree list --porcelain
        const isWorktreeList = args.includes("worktree") && args.includes("list");
        if (isWorktreeList) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode(worktreeListOutput),
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
      stat: (path) => {
        const pathStr = String(path);
        // .vibe.toml existence check
        const isVibeToml = pathStr.endsWith(".vibe.toml") && !pathStr.endsWith(".local.toml");
        if (isVibeToml) {
          if (vibeTomlExists) {
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
        // .vibe.local.toml always not found
        const isLocalToml = pathStr.endsWith(".vibe.local.toml");
        if (isLocalToml) {
          return Promise.reject(new Error("ENOENT"));
        }
        return Promise.resolve({
          isFile: true,
          isDirectory: false,
          isSymlink: false,
          size: 0,
          mtime: null,
          atime: null,
          birthtime: null,
          mode: null,
        });
      },
      readTextFile: (path) => {
        const pathStr = String(path);
        const isVibeToml = pathStr.endsWith(".vibe.toml");
        if (isVibeToml && vibeTomlContent) {
          return Promise.resolve(vibeTomlContent);
        }
        return Promise.resolve("");
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
      cwd: () => cwd,
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
  });

  return { ctx, getExitCode: () => exitCode, stderrOutput, consoleErrorSpy, consoleWarnSpy };
}

describe("copyCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits with error when run on main worktree", async () => {
    const { ctx, getExitCode, stderrOutput, consoleErrorSpy } = createCopyTestContext({
      cwd: "/tmp/main-repo",
      mainWorktreePath: "/tmp/main-repo",
      isMainWorktree: true,
    });

    await copyCommand({}, ctx);
    consoleErrorSpy.mockRestore();

    expect(getExitCode()).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) => line.includes("Not in a worktree"));
    expect(hasErrorMessage).toBe(true);
  });

  it("exits with error when run on main worktree with --target pointing to same path", async () => {
    const { ctx, getExitCode, stderrOutput, consoleErrorSpy } = createCopyTestContext({
      cwd: "/tmp/main-repo",
      mainWorktreePath: "/tmp/main-repo",
      isMainWorktree: true,
    });

    await copyCommand({ target: "/tmp/main-repo" }, ctx);
    consoleErrorSpy.mockRestore();

    expect(getExitCode()).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) => line.includes("Not in a worktree"));
    expect(hasErrorMessage).toBe(true);
  });

  it("skips when no copy configuration exists", async () => {
    const { ctx, getExitCode, consoleErrorSpy } = createCopyTestContext({
      cwd: "/tmp/worktree",
      mainWorktreePath: "/tmp/main-repo",
      vibeTomlExists: false,
    });

    await copyCommand({ verbose: true }, ctx);
    consoleErrorSpy.mockRestore();

    // Should not exit with error (exitCode should be null - no exit called)
    expect(getExitCode()).toBeNull();
  });

  it("uses --target option when provided", async () => {
    const { ctx, getExitCode, consoleErrorSpy } = createCopyTestContext({
      cwd: "/tmp/somewhere",
      mainWorktreePath: "/tmp/main-repo",
      vibeTomlExists: false,
    });

    await copyCommand({ target: "/tmp/another-worktree" }, ctx);
    consoleErrorSpy.mockRestore();

    // Should not exit with error
    expect(getExitCode()).toBeNull();
  });
});
