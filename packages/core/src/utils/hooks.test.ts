import { describe, it, expect, beforeAll } from "vitest";
import { type HookEnvironment, type HookTrackerInfo, runHooks } from "./hooks.ts";
import { createMockContext, setupTestContext } from "../context/testing.ts";
import { ProgressTracker } from "./progress.ts";

// Initialize test context for modules that depend on getGlobalContext()
beforeAll(() => {
  setupTestContext();
});

describe("runHooks", () => {
  it("executes multiple commands sequentially", async () => {
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

    expect(executionOrder).toEqual(commands);
  });

  it("throws error on non-zero exit code", async () => {
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

    await expect(runHooks(commands, cwd, env, undefined, ctx)).rejects.toThrow(
      "Hook failed with exit code 1: failing-command",
    );
  });

  it("tracks progress with startTask/completeTask", async () => {
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

    expect(trackerCalls).toEqual([
      "start:task-1",
      "complete:task-1",
      "start:task-2",
      "complete:task-2",
    ]);
  });

  it("tracks progress with failTask on error", async () => {
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

    await expect(runHooks(commands, cwd, env, trackerInfo, ctx)).rejects.toThrow("Hook failed");

    expect(trackerCalls).toEqual(["start:task-1", "fail:task-1:Exit code 127"]);
  });

  it("injects VIBE environment variables", async () => {
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

    expect(capturedEnv?.VIBE_WORKTREE_PATH).toBe("/path/to/worktree");
    expect(capturedEnv?.VIBE_ORIGIN_PATH).toBe("/path/to/origin");
  });

  it("succeeds with empty commands array", async () => {
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

    expect(runCalled).toBe(false);
  });

  it("uses correct shell on darwin/linux", async () => {
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

    expect(capturedShell).toBe("sh");
    expect(capturedArgs).toEqual(["-c", "echo hello"]);
  });

  it("uses cmd on windows", async () => {
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

    expect(capturedShell).toBe("cmd");
    expect(capturedArgs).toEqual(["/c", "echo hello"]);
  });

  it("stops execution on first failure", async () => {
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

    await expect(runHooks(commands, cwd, env, undefined, ctx)).rejects.toThrow("Hook failed");

    expect(executionOrder).toEqual(["cmd1", "cmd2"]);
    expect(callCount).toBe(2);
  });
});
