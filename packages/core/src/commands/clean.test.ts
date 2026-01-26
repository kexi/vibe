import { assertEquals } from "@std/assert";
import { cleanCommand } from "./clean.ts";
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

Deno.test("cleanCommand exits with error when run from main worktree", async () => {
  let exitCode: number | null = null;
  const stderr = captureStderr();

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

  stderr.restore();

  assertEquals(exitCode, 1);
  const hasErrorMessage = stderr.output.some((line) => line.includes("Cannot clean main worktree"));
  assertEquals(
    hasErrorMessage,
    true,
    `Expected main worktree error but got: ${stderr.output.join("\n")}`,
  );
});

Deno.test("cleanCommand shows error on exception", async () => {
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

  await cleanCommand({}, ctx);

  stderr.restore();

  assertEquals(exitCode, 1);
  const hasErrorMessage = stderr.output.some((line) => line.includes("Error:"));
  assertEquals(hasErrorMessage, true);
});

// Helper to capture console output
function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  return {
    output,
    restore: () => {
      console.log = originalLog;
    },
  };
}

Deno.test("cleanCommand exits gracefully when worktree already removed", async () => {
  const stdout = captureStdout();

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

  stdout.restore();

  // Should output cd command and "already removed" message
  const hasCdCommand = stdout.output.some((line) => line.includes("cd '"));
  assertEquals(hasCdCommand, true, `Expected cd command but got: ${stdout.output.join("\n")}`);
});

Deno.test("cleanCommand shows actionable error when main worktree is deleted", async () => {
  let exitCode: number | null = null;
  const stderr = captureStderr();

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

  stderr.restore();

  assertEquals(exitCode, 1);

  const errorOutput = stderr.output.join("\n");
  const hasMainWorktreeDeletedMessage = errorOutput.includes(
    "main worktree appears to have been deleted",
  );
  assertEquals(
    hasMainWorktreeDeletedMessage,
    true,
    `Expected 'main worktree appears to have been deleted' but got: ${errorOutput}`,
  );

  const hasRmRfInstruction = errorOutput.includes("rm -rf");
  assertEquals(
    hasRmRfInstruction,
    true,
    `Expected 'rm -rf' instruction but got: ${errorOutput}`,
  );

  const hasWorktreePruneInstruction = errorOutput.includes("git worktree prune");
  assertEquals(
    hasWorktreePruneInstruction,
    true,
    `Expected 'git worktree prune' instruction but got: ${errorOutput}`,
  );
});
