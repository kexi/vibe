import { describe, it, expect, vi, afterEach } from "vitest";
import { copyCommand } from "./copy.ts";
import { createMockContext } from "../context/testing.ts";
import type { RuntimeIO, RunResult } from "../runtime/types.ts";

/**
 * Helper to create a mock context for copy command tests.
 * Simulates git worktree list with a main worktree and an optional secondary worktree.
 */
/**
 * Build a settings.json content that trusts .vibe.toml with skipHashCheck enabled.
 * This allows tests to bypass SHA-256 trust verification.
 */
function buildTrustedSettingsJson(mainWorktreePath: string): string {
  return JSON.stringify({
    version: 3,
    skipHashCheck: true,
    permissions: {
      allow: [
        {
          repoId: { repoRoot: mainWorktreePath },
          relativePath: ".vibe.toml",
          hashes: [],
          skipHashCheck: true,
        },
      ],
      deny: [],
    },
  });
}

function createCopyTestContext(options: {
  cwd?: string;
  mainWorktreePath?: string;
  isMainWorktree?: boolean;
  vibeTomlContent?: string;
  vibeTomlExists?: boolean;
  io?: Partial<RuntimeIO>;
}) {
  const {
    cwd = "/tmp/worktree",
    mainWorktreePath = "/tmp/main-repo",
    isMainWorktree = false,
    vibeTomlContent,
    vibeTomlExists = vibeTomlContent !== undefined,
    io,
  } = options;

  const homePath = "/tmp/test-home";
  const settingsJsonPath = `${homePath}/.config/vibe/settings.json`;

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
    env: {
      get: (key: string) => {
        const isHome = key === "HOME";
        if (isHome) return homePath;
        return undefined;
      },
    },
    process: {
      run: (opts) => {
        const args = opts.args as string[];

        // Mock: git -C <dir> rev-parse --show-toplevel (used by getRepoInfoFromPath)
        const hasDashC = args.includes("-C");
        const isRevParse = args.includes("rev-parse") && args.includes("--show-toplevel");
        if (hasDashC && isRevParse) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode(`${mainWorktreePath}\n`),
            stderr: new Uint8Array(),
          } as RunResult);
        }

        // Mock: git rev-parse --show-toplevel (without -C, used by getRepoRoot)
        if (isRevParse) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode(`${cwd}\n`),
            stderr: new Uint8Array(),
          } as RunResult);
        }

        // Mock: git -C <dir> config --get remote.origin.url (used by getRepoInfoFromPath)
        const isConfigGet = args.includes("config") && args.includes("--get");
        if (hasDashC && isConfigGet) {
          return Promise.resolve({
            code: 1,
            success: false,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode("no remote\n"),
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

        // Return trusted settings for trust verification
        const isSettingsJson = pathStr === settingsJsonPath;
        if (isSettingsJson) {
          return Promise.resolve(buildTrustedSettingsJson(mainWorktreePath));
        }

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
    io,
  });

  return { ctx, getExitCode: () => exitCode, stderrOutput, consoleErrorSpy, consoleWarnSpy };
}

/**
 * Create a mock stdin that returns the given data bytes, then EOF.
 */
function createMockStdin(data: string, isTerminal = false): RuntimeIO["stdin"] {
  const encoded = new TextEncoder().encode(data);
  let offset = 0;
  return {
    read: (buf: Uint8Array) => {
      const isEof = offset >= encoded.length;
      if (isEof) return Promise.resolve(null);
      const remaining = encoded.length - offset;
      const bytesToCopy = Math.min(remaining, buf.length);
      buf.set(encoded.subarray(offset, offset + bytesToCopy));
      offset += bytesToCopy;
      return Promise.resolve(bytesToCopy);
    },
    isTerminal: () => isTerminal,
  };
}

/**
 * Create a mock stdin that returns EOF immediately (empty stdin).
 */
function createEmptyStdin(isTerminal = false): RuntimeIO["stdin"] {
  return {
    read: () => Promise.resolve(null),
    isTerminal: () => isTerminal,
  };
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

  it("exits with error when --target points to main worktree path", async () => {
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

  it("exits with error when in secondary worktree but --target points to main worktree", async () => {
    const { ctx, getExitCode, stderrOutput, consoleErrorSpy } = createCopyTestContext({
      cwd: "/tmp/worktree",
      mainWorktreePath: "/tmp/main-repo",
      isMainWorktree: false,
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

  describe("--dry-run", () => {
    it("does not exit with error in dry-run mode without config", async () => {
      const { ctx, getExitCode, consoleErrorSpy } = createCopyTestContext({
        cwd: "/tmp/worktree",
        mainWorktreePath: "/tmp/main-repo",
        vibeTomlExists: false,
      });

      await copyCommand({ dryRun: true }, ctx);
      consoleErrorSpy.mockRestore();

      expect(getExitCode()).toBeNull();
    });

    it("does not copy files in dry-run mode and outputs dry-run messages", async () => {
      const copyFileSpy = vi.fn(() => Promise.resolve());
      const { ctx, getExitCode, stderrOutput, consoleErrorSpy } = createCopyTestContext({
        cwd: "/tmp/worktree",
        mainWorktreePath: "/tmp/main-repo",
        vibeTomlContent: '[copy]\nfiles = ["README.md"]\n',
        vibeTomlExists: true,
      });

      // Override copyFile to track whether it is called
      ctx.runtime.fs.copyFile = copyFileSpy;

      await copyCommand({ dryRun: true }, ctx);
      consoleErrorSpy.mockRestore();

      expect(getExitCode()).toBeNull();
      expect(copyFileSpy).not.toHaveBeenCalled();

      // dry-run output should contain "[dry-run]" messages
      const hasDryRunOutput = stderrOutput.some((line) => line.includes("[dry-run]"));
      expect(hasDryRunOutput).toBe(true);
    });
  });

  describe("stdin target resolution", () => {
    it("uses cwd from valid stdin JSON as target", async () => {
      const stdinTarget = "/tmp/stdin-worktree";
      const { ctx, getExitCode, consoleErrorSpy } = createCopyTestContext({
        cwd: "/tmp/worktree",
        mainWorktreePath: "/tmp/main-repo",
        vibeTomlExists: false,
        io: {
          stdin: createMockStdin(JSON.stringify({ cwd: stdinTarget })),
        },
      });

      // No --target option, so stdin should be used as target
      await copyCommand({}, ctx);
      consoleErrorSpy.mockRestore();

      // stdinTarget differs from mainWorktreePath, so no error
      expect(getExitCode()).toBeNull();
    });

    it("falls back to repo root when stdin contains invalid JSON", async () => {
      const { ctx, getExitCode, consoleErrorSpy } = createCopyTestContext({
        cwd: "/tmp/worktree",
        mainWorktreePath: "/tmp/main-repo",
        vibeTomlExists: false,
        io: {
          stdin: createMockStdin("not valid json{{{"),
        },
      });

      await copyCommand({}, ctx);
      consoleErrorSpy.mockRestore();

      // Falls back to getRepoRoot() which returns cwd (/tmp/worktree)
      // cwd differs from mainWorktreePath, so no error
      expect(getExitCode()).toBeNull();
    });

    it("falls back to repo root when stdin is empty", async () => {
      const { ctx, getExitCode, consoleErrorSpy } = createCopyTestContext({
        cwd: "/tmp/worktree",
        mainWorktreePath: "/tmp/main-repo",
        vibeTomlExists: false,
        io: {
          stdin: createEmptyStdin(),
        },
      });

      await copyCommand({}, ctx);
      consoleErrorSpy.mockRestore();

      // Falls back to getRepoRoot() which returns cwd (/tmp/worktree)
      expect(getExitCode()).toBeNull();
    });

    it("falls back to repo root when stdin JSON has no cwd field", async () => {
      const { ctx, getExitCode, consoleErrorSpy } = createCopyTestContext({
        cwd: "/tmp/worktree",
        mainWorktreePath: "/tmp/main-repo",
        vibeTomlExists: false,
        io: {
          stdin: createMockStdin(JSON.stringify({ other: "value" })),
        },
      });

      await copyCommand({}, ctx);
      consoleErrorSpy.mockRestore();

      // Falls back to getRepoRoot() which returns cwd (/tmp/worktree)
      expect(getExitCode()).toBeNull();
    });

    it("ignores stdin when --target option is provided", async () => {
      const { ctx, getExitCode, consoleErrorSpy } = createCopyTestContext({
        cwd: "/tmp/worktree",
        mainWorktreePath: "/tmp/main-repo",
        vibeTomlExists: false,
        io: {
          stdin: createMockStdin(JSON.stringify({ cwd: "/tmp/stdin-worktree" })),
        },
      });

      // --target is explicitly provided, so stdin should be ignored
      await copyCommand({ target: "/tmp/another-worktree" }, ctx);
      consoleErrorSpy.mockRestore();

      expect(getExitCode()).toBeNull();
    });

    it("falls back to repo root when stdin is a terminal", async () => {
      const { ctx, getExitCode, consoleErrorSpy } = createCopyTestContext({
        cwd: "/tmp/worktree",
        mainWorktreePath: "/tmp/main-repo",
        vibeTomlExists: false,
        io: {
          stdin: createEmptyStdin(true),
        },
      });

      await copyCommand({}, ctx);
      consoleErrorSpy.mockRestore();

      // isTerminal() returns true, so stdin is skipped, falls back to getRepoRoot()
      expect(getExitCode()).toBeNull();
    });
  });
});
