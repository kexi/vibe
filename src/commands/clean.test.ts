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

// Helper to create git/gh mock responses for main worktree
function createMainWorktreeGitMock(
  currentBranch: string,
  defaultBranch: string,
) {
  return (opts: { cmd?: string; args?: string[] }) => {
    const cmd = opts.cmd ?? "git";
    const args = (opts.args ?? []) as string[];

    // Mock gh repo view (GitHub CLI) - for default branch detection
    if (cmd === "gh" && args.includes("repo") && args.includes("view")) {
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: new TextEncoder().encode(`${defaultBranch}\n`),
        stderr: new Uint8Array(),
      } as RunResult);
    }

    // Mock git rev-parse --show-toplevel (repo root)
    if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: new TextEncoder().encode("/tmp/mock-repo\n"),
        stderr: new Uint8Array(),
      } as RunResult);
    }

    // Mock git rev-parse --abbrev-ref HEAD (current branch)
    if (args.includes("rev-parse") && args.includes("--abbrev-ref") && args.includes("HEAD")) {
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: new TextEncoder().encode(`${currentBranch}\n`),
        stderr: new Uint8Array(),
      } as RunResult);
    }

    // Mock git worktree list to identify main worktree
    if (args.includes("worktree") && args.includes("list")) {
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: new TextEncoder().encode(
          `worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/${currentBranch}\n\n`,
        ),
        stderr: new Uint8Array(),
      } as RunResult);
    }

    // Mock git checkout
    if (args.includes("checkout")) {
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
  };
}

Deno.test("cleanCommand - main worktree already on default branch shows message and exits 0", async () => {
  let exitCode: number | null = null;
  const stderr = captureStderr();

  const ctx = createMockContext({
    process: {
      run: createMainWorktreeGitMock("develop", "develop"),
    },
    fs: {
      stat: () => Promise.reject(new Error("File not found")), // No .vibe.toml
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

  assertEquals(exitCode, 0);
  const hasMessage = stderr.output.some((line) => line.includes("already on the default branch"));
  assertEquals(
    hasMessage,
    true,
    `Expected 'already on default branch' message but got: ${stderr.output.join("\n")}`,
  );
});

Deno.test("cleanCommand - main worktree checkout default branch when user confirms", async () => {
  let exitCode: number | null = null;
  let checkoutBranch: string | null = null;
  const stderr = captureStderr();

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];

        // Capture checkout command
        if (args[0] === "checkout") {
          checkoutBranch = args[1];
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          } as RunResult);
        }

        return createMainWorktreeGitMock("feature/test", "develop")(
          opts as { cmd?: string; args?: string[] },
        );
      },
    },
    fs: {
      stat: () => Promise.reject(new Error("File not found")), // No .vibe.toml
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
    io: {
      stdin: {
        read: (buffer: Uint8Array) => {
          // Simulate user pressing Enter (accepting default Y)
          const input = new TextEncoder().encode("\n");
          buffer.set(input);
          return Promise.resolve(input.length);
        },
        isTerminal: () => true,
      },
      stderr: {
        writeSync: () => 0,
        write: () => Promise.resolve(0),
        isTerminal: () => true,
      },
    },
  });

  await cleanCommand({}, ctx);

  stderr.restore();

  assertEquals(exitCode, 0);
  assertEquals(checkoutBranch, "develop");
  const hasSwitchedMessage = stderr.output.some((line) => line.includes("Switched to"));
  assertEquals(
    hasSwitchedMessage,
    true,
    `Expected 'Switched to' message but got: ${stderr.output.join("\n")}`,
  );
});

Deno.test("cleanCommand - main worktree exits gracefully when user declines", async () => {
  let exitCode: number | null = null;
  let checkoutCalled = false;

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];

        // Check if checkout was called
        if (args[0] === "checkout") {
          checkoutCalled = true;
        }

        return createMainWorktreeGitMock("feature/test", "develop")(
          opts as { cmd?: string; args?: string[] },
        );
      },
    },
    fs: {
      stat: () => Promise.reject(new Error("File not found")), // No .vibe.toml
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
    io: {
      stdin: {
        read: (buffer: Uint8Array) => {
          // Simulate user typing 'n'
          const input = new TextEncoder().encode("n\n");
          buffer.set(input);
          return Promise.resolve(input.length);
        },
        isTerminal: () => true,
      },
      stderr: {
        writeSync: () => 0,
        write: () => Promise.resolve(0),
        isTerminal: () => true,
      },
    },
  });

  await cleanCommand({}, ctx);

  assertEquals(exitCode, 0);
  assertEquals(checkoutCalled, false, "Checkout should not have been called");
});

Deno.test("cleanCommand - main worktree skips checkout when gh is unavailable", async () => {
  let exitCode: number | null = null;

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const cmd = opts.cmd ?? "git";
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
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode(
              "worktree /tmp/mock-repo\nHEAD abc123\nbranch refs/heads/main\n\n",
            ),
            stderr: new Uint8Array(),
          } as RunResult);
        }

        // Mock gh repo view failing (gh not installed or not logged in)
        if (cmd === "gh" && args.includes("repo") && args.includes("view")) {
          return Promise.resolve({
            code: 1,
            success: false,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode("gh: command not found"),
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
      stat: () => Promise.reject(new Error("File not found")), // No .vibe.toml
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

  // Should exit gracefully (0) instead of showing an error
  assertEquals(exitCode, 0, "Should exit with 0 when gh is unavailable");
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
