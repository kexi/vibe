import { assertEquals, assertRejects } from "@std/assert";
import { type HookEnvironment, type HookTrackerInfo, runHooks } from "./hooks.ts";
import { createMockContext } from "../context/testing.ts";
import type { RunResult } from "../runtime/types.ts";
import { ProgressTracker } from "./progress.ts";

// Helper to capture console output
function captureConsoleError(): { output: string[]; restore: () => void } {
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

Deno.test("runHooks executes commands sequentially", async () => {
  const executedCommands: string[] = [];

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        executedCommands.push(args[1]); // -c command
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        } as RunResult);
      },
    },
    build: {
      os: "darwin",
      arch: "aarch64",
    },
  });

  const env: HookEnvironment = {
    worktreePath: "/path/to/worktree",
    originPath: "/path/to/origin",
  };

  await runHooks(["echo first", "echo second", "echo third"], "/cwd", env, undefined, ctx);

  assertEquals(executedCommands, ["echo first", "echo second", "echo third"]);
});

Deno.test("runHooks sets VIBE_WORKTREE_PATH and VIBE_ORIGIN_PATH environment variables", async () => {
  let capturedEnv: Record<string, string> | undefined;

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        capturedEnv = opts.env;
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        } as RunResult);
      },
    },
    env: {
      get: () => undefined,
      set: () => {},
      delete: () => {},
      toObject: () => ({ EXISTING_VAR: "existing_value" }),
    },
    build: {
      os: "darwin",
      arch: "aarch64",
    },
  });

  const env: HookEnvironment = {
    worktreePath: "/path/to/worktree",
    originPath: "/path/to/origin",
  };

  await runHooks(["echo test"], "/cwd", env, undefined, ctx);

  assertEquals(capturedEnv?.VIBE_WORKTREE_PATH, "/path/to/worktree");
  assertEquals(capturedEnv?.VIBE_ORIGIN_PATH, "/path/to/origin");
  assertEquals(capturedEnv?.EXISTING_VAR, "existing_value");
});

Deno.test("runHooks throws error when hook fails", async () => {
  const ctx = createMockContext({
    process: {
      run: () =>
        Promise.resolve({
          code: 1,
          success: false,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode("command failed"),
        } as RunResult),
    },
    build: {
      os: "darwin",
      arch: "aarch64",
    },
    io: {
      stdin: {
        read: () => Promise.resolve(null),
        isTerminal: () => false,
      },
      stderr: {
        writeSync: () => 0,
        write: () => Promise.resolve(0),
        isTerminal: () => false,
      },
    },
  });

  const env: HookEnvironment = {
    worktreePath: "/path/to/worktree",
    originPath: "/path/to/origin",
  };

  await assertRejects(
    async () => {
      await runHooks(["failing-command"], "/cwd", env, undefined, ctx);
    },
    Error,
    "Hook failed with exit code 1: failing-command",
  );
});

Deno.test("runHooks starts and completes tasks when trackerInfo is provided", async () => {
  const startedTasks: string[] = [];
  const completedTasks: string[] = [];

  const mockTracker = {
    startTask: (taskId: string) => {
      startedTasks.push(taskId);
    },
    completeTask: (taskId: string) => {
      completedTasks.push(taskId);
    },
    failTask: () => {},
  } as unknown as ProgressTracker;

  const ctx = createMockContext({
    process: {
      run: () =>
        Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        } as RunResult),
    },
    build: {
      os: "darwin",
      arch: "aarch64",
    },
  });

  const env: HookEnvironment = {
    worktreePath: "/path/to/worktree",
    originPath: "/path/to/origin",
  };

  const trackerInfo: HookTrackerInfo = {
    tracker: mockTracker,
    taskIds: ["task-1", "task-2"],
  };

  await runHooks(["echo first", "echo second"], "/cwd", env, trackerInfo, ctx);

  assertEquals(startedTasks, ["task-1", "task-2"]);
  assertEquals(completedTasks, ["task-1", "task-2"]);
});

Deno.test("runHooks fails task when hook fails with trackerInfo", async () => {
  const failedTasks: { taskId: string; reason: string }[] = [];

  const mockTracker = {
    startTask: () => {},
    completeTask: () => {},
    failTask: (taskId: string, reason: string) => {
      failedTasks.push({ taskId, reason });
    },
  } as unknown as ProgressTracker;

  const ctx = createMockContext({
    process: {
      run: () =>
        Promise.resolve({
          code: 42,
          success: false,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        } as RunResult),
    },
    build: {
      os: "darwin",
      arch: "aarch64",
    },
    io: {
      stdin: {
        read: () => Promise.resolve(null),
        isTerminal: () => false,
      },
      stderr: {
        writeSync: () => 0,
        write: () => Promise.resolve(0),
        isTerminal: () => false,
      },
    },
  });

  const env: HookEnvironment = {
    worktreePath: "/path/to/worktree",
    originPath: "/path/to/origin",
  };

  const trackerInfo: HookTrackerInfo = {
    tracker: mockTracker,
    taskIds: ["task-1"],
  };

  await assertRejects(async () => {
    await runHooks(["failing-command"], "/cwd", env, trackerInfo, ctx);
  });

  assertEquals(failedTasks.length, 1);
  assertEquals(failedTasks[0].taskId, "task-1");
  assertEquals(failedTasks[0].reason, "Exit code 42");
});

Deno.test("runHooks writes stdout to stderr when trackerInfo is not provided", async () => {
  const writtenData: Uint8Array[] = [];

  const ctx = createMockContext({
    process: {
      run: () =>
        Promise.resolve({
          code: 0,
          success: true,
          stdout: new TextEncoder().encode("hook output"),
          stderr: new Uint8Array(),
        } as RunResult),
    },
    build: {
      os: "darwin",
      arch: "aarch64",
    },
    io: {
      stdin: {
        read: () => Promise.resolve(null),
        isTerminal: () => false,
      },
      stderr: {
        writeSync: () => 0,
        write: (data: Uint8Array) => {
          writtenData.push(data);
          return Promise.resolve(data.length);
        },
        isTerminal: () => false,
      },
    },
  });

  const env: HookEnvironment = {
    worktreePath: "/path/to/worktree",
    originPath: "/path/to/origin",
  };

  await runHooks(["echo test"], "/cwd", env, undefined, ctx);

  assertEquals(writtenData.length, 1);
  assertEquals(new TextDecoder().decode(writtenData[0]), "hook output");
});

Deno.test("runHooks suppresses stdout when trackerInfo is provided", async () => {
  const writtenData: Uint8Array[] = [];

  const mockTracker = {
    startTask: () => {},
    completeTask: () => {},
    failTask: () => {},
  } as unknown as ProgressTracker;

  const ctx = createMockContext({
    process: {
      run: () =>
        Promise.resolve({
          code: 0,
          success: true,
          stdout: new TextEncoder().encode("hook output"),
          stderr: new Uint8Array(),
        } as RunResult),
    },
    build: {
      os: "darwin",
      arch: "aarch64",
    },
    io: {
      stdin: {
        read: () => Promise.resolve(null),
        isTerminal: () => false,
      },
      stderr: {
        writeSync: () => 0,
        write: (data: Uint8Array) => {
          writtenData.push(data);
          return Promise.resolve(data.length);
        },
        isTerminal: () => false,
      },
    },
  });

  const env: HookEnvironment = {
    worktreePath: "/path/to/worktree",
    originPath: "/path/to/origin",
  };

  const trackerInfo: HookTrackerInfo = {
    tracker: mockTracker,
    taskIds: ["task-1"],
  };

  await runHooks(["echo test"], "/cwd", env, trackerInfo, ctx);

  // stdout should be suppressed when tracker is enabled
  assertEquals(writtenData.length, 0);
});

Deno.test("runHooks uses cmd shell on Windows", async () => {
  let capturedCmd: string | undefined;
  let capturedArgs: string[] | undefined;

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        capturedCmd = opts.cmd;
        capturedArgs = opts.args as string[];
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        } as RunResult);
      },
    },
    build: {
      os: "windows",
      arch: "x86_64",
    },
  });

  const env: HookEnvironment = {
    worktreePath: "C:\\path\\to\\worktree",
    originPath: "C:\\path\\to\\origin",
  };

  await runHooks(["echo test"], "C:\\cwd", env, undefined, ctx);

  assertEquals(capturedCmd, "cmd");
  assertEquals(capturedArgs, ["/c", "echo test"]);
});

Deno.test("runHooks uses sh shell on Unix-like systems", async () => {
  let capturedCmd: string | undefined;
  let capturedArgs: string[] | undefined;

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        capturedCmd = opts.cmd;
        capturedArgs = opts.args as string[];
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        } as RunResult);
      },
    },
    build: {
      os: "linux",
      arch: "x86_64",
    },
  });

  const env: HookEnvironment = {
    worktreePath: "/path/to/worktree",
    originPath: "/path/to/origin",
  };

  await runHooks(["echo test"], "/cwd", env, undefined, ctx);

  assertEquals(capturedCmd, "sh");
  assertEquals(capturedArgs, ["-c", "echo test"]);
});

Deno.test("runHooks handles stderr write failure gracefully", async () => {
  const stderr = captureConsoleError();

  const ctx = createMockContext({
    process: {
      run: () =>
        Promise.resolve({
          code: 0,
          success: true,
          stdout: new TextEncoder().encode("hook output"),
          stderr: new Uint8Array(),
        } as RunResult),
    },
    build: {
      os: "darwin",
      arch: "aarch64",
    },
    io: {
      stdin: {
        read: () => Promise.resolve(null),
        isTerminal: () => false,
      },
      stderr: {
        writeSync: () => 0,
        write: () => Promise.reject(new Error("Write failed")),
        isTerminal: () => false,
      },
    },
  });

  const env: HookEnvironment = {
    worktreePath: "/path/to/worktree",
    originPath: "/path/to/origin",
  };

  await runHooks(["echo test"], "/cwd", env, undefined, ctx);

  stderr.restore();

  // Should log warning instead of crashing
  const hasWarning = stderr.output.some((line) =>
    line.includes("Warning: Failed to write hook output to stderr")
  );
  assertEquals(hasWarning, true);
});

Deno.test("runHooks handles empty commands array", async () => {
  const executedCommands: string[] = [];

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        executedCommands.push(args[1]);
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        } as RunResult);
      },
    },
    build: {
      os: "darwin",
      arch: "aarch64",
    },
  });

  const env: HookEnvironment = {
    worktreePath: "/path/to/worktree",
    originPath: "/path/to/origin",
  };

  await runHooks([], "/cwd", env, undefined, ctx);

  assertEquals(executedCommands.length, 0);
});
