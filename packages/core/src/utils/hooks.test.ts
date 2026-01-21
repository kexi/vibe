import { assertEquals, assertRejects } from "@std/assert";
import { type HookEnvironment, type HookTrackerInfo, runHooks } from "./hooks.ts";
import { createMockContext, setupTestContext } from "../context/testing.ts";
import { ProgressTracker } from "./progress.ts";

// Initialize test context for modules that depend on getGlobalContext()
setupTestContext();

Deno.test("runHooks - executes multiple commands sequentially", async () => {
  const executionOrder: string[] = [];
  const ctx = createMockContext({
    process: {
      run: ({ args }) => {
        const cmd = args?.[1] as string;
        executionOrder.push(cmd);
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      },
    },
  });

  const commands = ["echo first", "echo second", "echo third"];
  const cwd = "/test/dir";
  const env: HookEnvironment = {
    worktreePath: "/test/worktree",
    originPath: "/test/origin",
  };

  await runHooks(commands, cwd, env, undefined, ctx);

  assertEquals(executionOrder, commands);
});

Deno.test("runHooks - throws error on non-zero exit code", async () => {
  const ctx = createMockContext({
    process: {
      run: () =>
        Promise.resolve({
          code: 1,
          success: false,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode("error output"),
        }),
    },
  });

  const commands = ["failing-command"];
  const cwd = "/test/dir";
  const env: HookEnvironment = {
    worktreePath: "/test/worktree",
    originPath: "/test/origin",
  };

  await assertRejects(
    async () => {
      await runHooks(commands, cwd, env, undefined, ctx);
    },
    Error,
    "Hook failed with exit code 1: failing-command",
  );
});

Deno.test("runHooks - tracks progress with startTask/completeTask", async () => {
  const trackerCalls: string[] = [];

  const ctx = createMockContext({
    process: {
      run: () =>
        Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        }),
    },
  });

  const tracker = new ProgressTracker({ enabled: false });
  tracker.addPhase("Test phase");
  const taskIds = ["task-1", "task-2"];

  // Override tracker methods to capture calls
  const originalStartTask = tracker.startTask.bind(tracker);
  const originalCompleteTask = tracker.completeTask.bind(tracker);
  tracker.startTask = (id: string) => {
    trackerCalls.push(`start:${id}`);
    originalStartTask(id);
  };
  tracker.completeTask = (id: string) => {
    trackerCalls.push(`complete:${id}`);
    originalCompleteTask(id);
  };

  const trackerInfo: HookTrackerInfo = { tracker, taskIds };

  const commands = ["cmd1", "cmd2"];
  const cwd = "/test/dir";
  const env: HookEnvironment = {
    worktreePath: "/test/worktree",
    originPath: "/test/origin",
  };

  await runHooks(commands, cwd, env, trackerInfo, ctx);

  assertEquals(trackerCalls, [
    "start:task-1",
    "complete:task-1",
    "start:task-2",
    "complete:task-2",
  ]);
});

Deno.test("runHooks - tracks progress with failTask on error", async () => {
  const trackerCalls: string[] = [];

  const ctx = createMockContext({
    process: {
      run: () =>
        Promise.resolve({
          code: 127,
          success: false,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        }),
    },
  });

  const tracker = new ProgressTracker({ enabled: false });
  tracker.addPhase("Test phase");
  const taskIds = ["task-1"];

  // Override tracker methods to capture calls
  const originalStartTask = tracker.startTask.bind(tracker);
  const originalFailTask = tracker.failTask.bind(tracker);
  tracker.startTask = (id: string) => {
    trackerCalls.push(`start:${id}`);
    originalStartTask(id);
  };
  tracker.failTask = (id: string, reason?: string) => {
    trackerCalls.push(`fail:${id}:${reason}`);
    originalFailTask(id, reason);
  };

  const trackerInfo: HookTrackerInfo = { tracker, taskIds };

  const commands = ["failing-cmd"];
  const cwd = "/test/dir";
  const env: HookEnvironment = {
    worktreePath: "/test/worktree",
    originPath: "/test/origin",
  };

  await assertRejects(
    async () => {
      await runHooks(commands, cwd, env, trackerInfo, ctx);
    },
    Error,
    "Hook failed",
  );

  assertEquals(trackerCalls, ["start:task-1", "fail:task-1:Exit code 127"]);
});

Deno.test("runHooks - injects VIBE environment variables", async () => {
  let capturedEnv: Record<string, string> | undefined;

  const ctx = createMockContext({
    process: {
      run: ({ env }) => {
        capturedEnv = env;
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      },
    },
  });

  const commands = ["test-cmd"];
  const cwd = "/test/dir";
  const env: HookEnvironment = {
    worktreePath: "/path/to/worktree",
    originPath: "/path/to/origin",
  };

  await runHooks(commands, cwd, env, undefined, ctx);

  assertEquals(capturedEnv?.VIBE_WORKTREE_PATH, "/path/to/worktree");
  assertEquals(capturedEnv?.VIBE_ORIGIN_PATH, "/path/to/origin");
});

Deno.test("runHooks - succeeds with empty commands array", async () => {
  let runCalled = false;
  const ctx = createMockContext({
    process: {
      run: () => {
        runCalled = true;
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      },
    },
  });

  const commands: string[] = [];
  const cwd = "/test/dir";
  const env: HookEnvironment = {
    worktreePath: "/test/worktree",
    originPath: "/test/origin",
  };

  await runHooks(commands, cwd, env, undefined, ctx);

  assertEquals(runCalled, false);
});

Deno.test("runHooks - uses correct shell on darwin/linux", async () => {
  let capturedShell: string | undefined;
  let capturedArgs: string[] | undefined;

  const ctx = createMockContext({
    build: { os: "darwin", arch: "aarch64" },
    process: {
      run: ({ cmd, args }) => {
        capturedShell = cmd;
        capturedArgs = args;
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      },
    },
  });

  const commands = ["echo hello"];
  const cwd = "/test/dir";
  const env: HookEnvironment = {
    worktreePath: "/test/worktree",
    originPath: "/test/origin",
  };

  await runHooks(commands, cwd, env, undefined, ctx);

  assertEquals(capturedShell, "sh");
  assertEquals(capturedArgs, ["-c", "echo hello"]);
});

Deno.test("runHooks - uses cmd on windows", async () => {
  let capturedShell: string | undefined;
  let capturedArgs: string[] | undefined;

  const ctx = createMockContext({
    build: { os: "windows", arch: "x86_64" },
    process: {
      run: ({ cmd, args }) => {
        capturedShell = cmd;
        capturedArgs = args;
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      },
    },
  });

  const commands = ["echo hello"];
  const cwd = "/test/dir";
  const env: HookEnvironment = {
    worktreePath: "/test/worktree",
    originPath: "/test/origin",
  };

  await runHooks(commands, cwd, env, undefined, ctx);

  assertEquals(capturedShell, "cmd");
  assertEquals(capturedArgs, ["/c", "echo hello"]);
});

Deno.test("runHooks - stops execution on first failure", async () => {
  const executionOrder: string[] = [];
  let callCount = 0;

  const ctx = createMockContext({
    process: {
      run: ({ args }) => {
        callCount++;
        const cmd = args?.[1] as string;
        executionOrder.push(cmd);

        const shouldFail = cmd === "cmd2";
        return Promise.resolve({
          code: shouldFail ? 1 : 0,
          success: !shouldFail,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      },
    },
  });

  const commands = ["cmd1", "cmd2", "cmd3"];
  const cwd = "/test/dir";
  const env: HookEnvironment = {
    worktreePath: "/test/worktree",
    originPath: "/test/origin",
  };

  await assertRejects(
    async () => {
      await runHooks(commands, cwd, env, undefined, ctx);
    },
    Error,
    "Hook failed",
  );

  assertEquals(executionOrder, ["cmd1", "cmd2"]);
  assertEquals(callCount, 2);
});
