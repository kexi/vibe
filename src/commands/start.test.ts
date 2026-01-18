import { assertEquals } from "@std/assert";
import { startCommand } from "./start.ts";
import { createMockContext } from "../context/testing.ts";
import type { FileInfo, RunResult } from "../runtime/types.ts";

// Helper to capture console output
function captureOutput(): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  };

  return {
    stdout,
    stderr,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
}

// Mock git command responses
function createGitMock(overrides: {
  repoRoot?: string;
  repoName?: string;
  branchExists?: boolean;
  worktreeList?: string[];
  worktreeForBranch?: string;
} = {}) {
  const {
    repoRoot = "/test/repo",
    repoName = "repo",
    branchExists = false,
    worktreeList = [],
    worktreeForBranch,
  } = overrides;

  return (opts: { args?: string[] }) => {
    const args = opts.args as string[];

    // git rev-parse --show-toplevel
    if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: new TextEncoder().encode(`${repoRoot}\n`),
        stderr: new Uint8Array(),
      } as RunResult);
    }

    // git rev-parse --git-dir (for repo name)
    if (args.includes("rev-parse") && args.includes("--git-dir")) {
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: new TextEncoder().encode(`.git\n`),
        stderr: new Uint8Array(),
      } as RunResult);
    }

    // git remote get-url origin (for repo name)
    if (args.includes("remote") && args.includes("get-url")) {
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: new TextEncoder().encode(`git@github.com:user/${repoName}.git\n`),
        stderr: new Uint8Array(),
      } as RunResult);
    }

    // git show-ref --verify (check if branch exists)
    if (args.includes("show-ref") && args.includes("--verify")) {
      return Promise.resolve({
        code: branchExists ? 0 : 1,
        success: branchExists,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      } as RunResult);
    }

    // git worktree list --porcelain
    if (args.includes("worktree") && args.includes("list")) {
      let output = "";
      for (const path of worktreeList) {
        output += `worktree ${path}\nHEAD abc123\nbranch refs/heads/main\n\n`;
      }
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: new TextEncoder().encode(output),
        stderr: new Uint8Array(),
      } as RunResult);
    }

    // git for-each-ref (check if branch is used in worktree)
    if (args.includes("for-each-ref")) {
      if (worktreeForBranch) {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new TextEncoder().encode(worktreeForBranch + "\n"),
          stderr: new Uint8Array(),
        } as RunResult);
      }
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      } as RunResult);
    }

    // git worktree add
    if (args.includes("worktree") && args.includes("add")) {
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      } as RunResult);
    }

    // git worktree remove
    if (args.includes("worktree") && args.includes("remove")) {
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      } as RunResult);
    }

    // Default response
    return Promise.resolve({
      code: 0,
      success: true,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    } as RunResult);
  };
}

Deno.test("startCommand exits with error when branch name is empty", async () => {
  let exitCode: number | null = null;
  const output = captureOutput();

  const ctx = createMockContext({
    control: {
      exit: ((code: number) => {
        exitCode = code;
      }) as never,
      cwd: () => "/test/repo",
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
  });

  await startCommand("", {}, ctx);

  output.restore();

  assertEquals(exitCode, 1);
  const hasErrorMessage = output.stderr.some((line) => line.includes("Branch name is required"));
  assertEquals(hasErrorMessage, true);
});

Deno.test("startCommand creates worktree for new branch", async () => {
  let exitCode: number | null = null;
  let worktreeAddCalled = false;
  const output = captureOutput();

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        if (args.includes("worktree") && args.includes("add")) {
          worktreeAddCalled = true;
        }
        return createGitMock({ branchExists: false })(opts);
      },
    },
    fs: {
      stat: () => Promise.reject(new Error("File not found")),
      readTextFile: () => Promise.reject(new Error("File not found")),
    },
    control: {
      exit: ((code: number) => {
        exitCode = code;
      }) as never,
      cwd: () => "/test/repo",
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
    env: {
      get: (key: string) => {
        if (key === "HOME") return "/home/user";
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

  await startCommand("feature/new-branch", {}, ctx);

  output.restore();

  assertEquals(exitCode, null); // No error exit
  assertEquals(worktreeAddCalled, true);
  // Should output cd command
  const hasCdCommand = output.stdout.some((line) => line.startsWith("cd '"));
  assertEquals(hasCdCommand, true);
});

Deno.test("startCommand creates worktree for existing branch", async () => {
  let worktreeAddCalled = false;
  let usedExistingBranch = false;
  const output = captureOutput();

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        if (args.includes("worktree") && args.includes("add")) {
          worktreeAddCalled = true;
          // Check if -b flag is NOT used (existing branch)
          usedExistingBranch = !args.includes("-b");
        }
        return createGitMock({ branchExists: true })(opts);
      },
    },
    fs: {
      stat: () => Promise.reject(new Error("File not found")),
      readTextFile: () => Promise.reject(new Error("File not found")),
    },
    control: {
      exit: (() => {}) as never,
      cwd: () => "/test/repo",
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
    env: {
      get: (key: string) => {
        if (key === "HOME") return "/home/user";
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

  await startCommand("feature/existing-branch", {}, ctx);

  output.restore();

  assertEquals(worktreeAddCalled, true);
  assertEquals(usedExistingBranch, true);
});

Deno.test("startCommand handles dry-run option", async () => {
  let worktreeAddCalled = false;
  const output = captureOutput();

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        if (args.includes("worktree") && args.includes("add")) {
          worktreeAddCalled = true;
        }
        return createGitMock()(opts);
      },
    },
    fs: {
      stat: () => Promise.reject(new Error("File not found")),
      readTextFile: () => Promise.reject(new Error("File not found")),
    },
    control: {
      exit: (() => {}) as never,
      cwd: () => "/test/repo",
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
    env: {
      get: (key: string) => {
        if (key === "HOME") return "/home/user";
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

  await startCommand("feature/test", { dryRun: true }, ctx);

  output.restore();

  // In dry-run, worktree add should NOT be called
  assertEquals(worktreeAddCalled, false);

  // Should have dry-run messages
  const hasDryRunMessage = output.stderr.some((line) => line.includes("[dry-run]"));
  assertEquals(hasDryRunMessage, true);
});

Deno.test("startCommand handles noHooks option", async () => {
  let hookRun = false;
  const output = captureOutput();

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        // Check if hook command (sh -c) was called for non-git commands
        if (opts.cmd === "sh" && args[0] === "-c") {
          hookRun = true;
        }
        return createGitMock()(opts);
      },
    },
    fs: {
      stat: (path: string) => {
        // Config file exists
        if (path.includes(".vibe.toml")) {
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
        return Promise.reject(new Error("File not found"));
      },
      readTextFile: (path: string) => {
        if (path.includes(".vibe.toml")) {
          return Promise.resolve(`
[hooks]
pre_start = ["echo pre-hook"]
post_start = ["echo post-hook"]
`);
        }
        return Promise.reject(new Error("File not found"));
      },
    },
    control: {
      exit: (() => {}) as never,
      cwd: () => "/test/repo",
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
    env: {
      get: (key: string) => {
        if (key === "HOME") return "/home/user";
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

  await startCommand("feature/test", { noHooks: true }, ctx);

  output.restore();

  // Hooks should NOT be run
  assertEquals(hookRun, false);
});

Deno.test("startCommand handles noCopy option", async () => {
  let copyFileCalled = false;
  const output = captureOutput();

  const ctx = createMockContext({
    process: {
      run: createGitMock(),
    },
    fs: {
      stat: (path: string) => {
        if (path.includes(".vibe.toml") || path.includes(".env")) {
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
        return Promise.reject(new Error("File not found"));
      },
      readTextFile: (path: string) => {
        if (path.includes(".vibe.toml")) {
          return Promise.resolve(`
[copy]
files = [".env"]
`);
        }
        return Promise.reject(new Error("File not found"));
      },
      copyFile: () => {
        copyFileCalled = true;
        return Promise.resolve();
      },
    },
    control: {
      exit: (() => {}) as never,
      cwd: () => "/test/repo",
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
    env: {
      get: (key: string) => {
        if (key === "HOME") return "/home/user";
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

  await startCommand("feature/test", { noCopy: true }, ctx);

  output.restore();

  // Copy should NOT be called
  assertEquals(copyFileCalled, false);
});

Deno.test("startCommand sanitizes branch name with slashes", async () => {
  let worktreePath = "";
  const output = captureOutput();

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        if (args.includes("worktree") && args.includes("add")) {
          // For new branch: git worktree add -b <branchName> <worktreePath>
          // For existing branch: git worktree add <worktreePath> <branchName>
          const hasNewBranchFlag = args.includes("-b");
          if (hasNewBranchFlag) {
            // worktreePath is the last arg
            worktreePath = args[args.length - 1];
          } else {
            // worktreePath is the arg after 'add'
            const addIndex = args.indexOf("add");
            worktreePath = args[addIndex + 1];
          }
        }
        return createGitMock()(opts);
      },
    },
    fs: {
      stat: () => Promise.reject(new Error("File not found")),
      readTextFile: () => Promise.reject(new Error("File not found")),
    },
    control: {
      exit: (() => {}) as never,
      cwd: () => "/test/repo",
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
    env: {
      get: (key: string) => {
        if (key === "HOME") return "/home/user";
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

  await startCommand("feature/deep/nested/branch", {}, ctx);

  output.restore();

  // Branch name should be sanitized (slashes converted to dashes)
  const sanitizedPart = "feature-deep-nested-branch";
  const hasCorrectPath = worktreePath.includes(sanitizedPart);
  assertEquals(hasCorrectPath, true);
});

Deno.test("startCommand handles verbose option", async () => {
  const output = captureOutput();

  const ctx = createMockContext({
    process: {
      run: createGitMock(),
    },
    fs: {
      stat: () => Promise.reject(new Error("File not found")),
      readTextFile: () => Promise.reject(new Error("File not found")),
    },
    control: {
      exit: (() => {}) as never,
      cwd: () => "/test/repo",
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
    env: {
      get: (key: string) => {
        if (key === "HOME") return "/home/user";
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

  await startCommand("feature/test", { verbose: true }, ctx);

  output.restore();

  // Verbose output should contain repository info
  const hasVerboseOutput = output.stderr.some(
    (line) => line.includes("Repository root:") || line.includes("Repository name:"),
  );
  assertEquals(hasVerboseOutput, true);
});
