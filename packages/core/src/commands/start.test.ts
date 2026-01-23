import { assertEquals } from "@std/assert";
import { startCommand } from "./start.ts";
import { createMockContext } from "../context/testing.ts";
import type { RunResult } from "../runtime/types.ts";

// Helper to capture console output
function captureStderr(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  return {
    output,
    restore: () => {
      console.error = originalError;
    },
  };
}

Deno.test("startCommand exits with error when branch name is empty", async () => {
  let exitCode: number | null = null;
  const stderr = captureStderr();

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

  stderr.restore();

  assertEquals(exitCode, 1);
  const hasErrorMessage = stderr.output.some((line) => line.includes("Branch name is required"));
  assertEquals(
    hasErrorMessage,
    true,
    `Expected branch name error but got: ${stderr.output.join("\n")}`,
  );
});

Deno.test("startCommand exits with error when not in a git repository", async () => {
  let exitCode: number | null = null;
  const stderr = captureStderr();

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        // Mock git rev-parse --show-toplevel failing (not in a repo)
        if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
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

  stderr.restore();

  assertEquals(exitCode, 1);
  const hasErrorMessage = stderr.output.some((line) => line.includes("Error:"));
  assertEquals(
    hasErrorMessage,
    true,
    `Expected error message but got: ${stderr.output.join("\n")}`,
  );
});

Deno.test("startCommand dry-run mode does not create worktree", async () => {
  let exitCode: number | null = null;
  let worktreeCreated = false;
  const stderr = captureStderr();

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        // Mock git rev-parse --show-toplevel
        if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode("/tmp/mock-repo\n"),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        // Mock git rev-parse --show-superproject-working-tree
        if (args.includes("rev-parse") && args.includes("--show-superproject-working-tree")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        // Mock git remote get-url origin
        if (args.includes("remote") && args.includes("get-url")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode("git@github.com:kexi/vibe.git\n"),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        // Mock git worktree list (no existing worktrees using this branch)
        if (args.includes("worktree") && args.includes("list")) {
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
        if (args.includes("branch") && args.includes("--list")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        // Detect worktree add command
        if (args.includes("worktree") && args.includes("add")) {
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

  stderr.restore();

  // In dry-run mode, worktree should NOT be created
  assertEquals(worktreeCreated, false, "Worktree should not be created in dry-run mode");
  // Dry-run output should contain [dry-run] prefix
  const hasDryRunOutput = stderr.output.some((line) => line.includes("[dry-run]"));
  assertEquals(
    hasDryRunOutput,
    true,
    `Expected [dry-run] output but got: ${stderr.output.join("\n")}`,
  );
  // Exit should not have been called (normal completion)
  assertEquals(exitCode, null);
});

Deno.test("startCommand dry-run uses base ref for new branch", async () => {
  let exitCode: number | null = null;
  const stderr = captureStderr();

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode("/tmp/mock-repo\n"),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        if (args.includes("rev-parse") && args.includes("--verify")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode("abc123\n"),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        if (args.includes("worktree") && args.includes("list")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode(
              "worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/main\n\n",
            ),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        if (args.includes("show-ref") && args.includes("--verify")) {
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

  stderr.restore();

  const hasBaseCommand = stderr.output.some((line) =>
    line.includes("git worktree add -b feat/base-branch") && line.includes(" main")
  );
  assertEquals(
    hasBaseCommand,
    true,
    `Expected base ref in dry-run command but got: ${stderr.output.join("\n")}`,
  );
  assertEquals(exitCode, null);
});

Deno.test("startCommand warns and ignores base when branch exists", async () => {
  let exitCode: number | null = null;
  const stderr = captureStderr();

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode("/tmp/mock-repo\n"),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        if (args.includes("worktree") && args.includes("list")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode(
              "worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/main\n\n",
            ),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        if (args.includes("show-ref") && args.includes("--verify")) {
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

  stderr.restore();

  const hasWarning = stderr.output.some((line) =>
    line.includes("Warning: Branch 'feat/existing' already exists; --base is ignored.")
  );
  assertEquals(hasWarning, true, `Expected warning but got: ${stderr.output.join("\n")}`);

  const baseUsed = stderr.output.some((line) =>
    line.includes("git worktree add") && line.includes(" main")
  );
  assertEquals(baseUsed, false, `Did not expect base in command: ${stderr.output.join("\n")}`);
  assertEquals(exitCode, null);
});

Deno.test("startCommand exits with error when base value looks like option", async () => {
  let exitCode: number | null = null;
  const stderr = captureStderr();

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode("/tmp/mock-repo\n"),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        if (args.includes("worktree") && args.includes("list")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode(
              "worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/main\n\n",
            ),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        if (args.includes("show-ref") && args.includes("--verify")) {
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

  stderr.restore();

  assertEquals(exitCode, 1);
  const hasError = stderr.output.some((line) => line.includes("Error: --base requires a value"));
  assertEquals(hasError, true, `Expected base error but got: ${stderr.output.join("\n")}`);
});

Deno.test("startCommand exits with error when base ref is invalid", async () => {
  let exitCode: number | null = null;
  const stderr = captureStderr();

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode("/tmp/mock-repo\n"),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        if (args.includes("rev-parse") && args.includes("--verify")) {
          return Promise.resolve({
            code: 1,
            success: false,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode("fatal: bad object\n"),
          } as RunResult);
        }
        if (args.includes("worktree") && args.includes("list")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode(
              "worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/main\n\n",
            ),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        if (args.includes("show-ref") && args.includes("--verify")) {
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

  stderr.restore();

  assertEquals(exitCode, 1);
  const hasError = stderr.output.some((line) =>
    line.includes("Error: Base 'no-such-ref' not found")
  );
  assertEquals(hasError, true, `Expected base error but got: ${stderr.output.join("\n")}`);
});

Deno.test("startCommand shows error on exception", async () => {
  let exitCode: number | null = null;
  const stderr = captureStderr();

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

  stderr.restore();

  assertEquals(exitCode, 1);
  const hasErrorMessage = stderr.output.some((line) => line.includes("Error:"));
  assertEquals(hasErrorMessage, true);
});
