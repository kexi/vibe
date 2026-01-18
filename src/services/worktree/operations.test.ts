import { assertEquals } from "@std/assert";
import { createMockContext } from "../../context/testing.ts";
import { createWorktree, getCreateWorktreeCommand, removeWorktree } from "./operations.ts";
import type { RunResult } from "../../runtime/types.ts";

// =============================================================================
// createWorktree tests
// =============================================================================

Deno.test("createWorktree executes git worktree add -b for new branch", async () => {
  let capturedArgs: string[] = [];

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        capturedArgs = opts.args as string[];
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        } as RunResult);
      },
    },
  });

  await createWorktree(
    {
      branchName: "feature-new",
      worktreePath: "/test/worktrees/feature-new",
      branchExists: false,
    },
    ctx,
  );

  assertEquals(capturedArgs.includes("worktree"), true);
  assertEquals(capturedArgs.includes("add"), true);
  assertEquals(capturedArgs.includes("-b"), true);
  assertEquals(capturedArgs.includes("feature-new"), true);
  assertEquals(capturedArgs.includes("/test/worktrees/feature-new"), true);
});

Deno.test("createWorktree executes git worktree add without -b for existing branch", async () => {
  let capturedArgs: string[] = [];

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        capturedArgs = opts.args as string[];
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        } as RunResult);
      },
    },
  });

  await createWorktree(
    {
      branchName: "existing-branch",
      worktreePath: "/test/worktrees/existing-branch",
      branchExists: true,
    },
    ctx,
  );

  assertEquals(capturedArgs.includes("worktree"), true);
  assertEquals(capturedArgs.includes("add"), true);
  assertEquals(capturedArgs.includes("-b"), false);
  assertEquals(capturedArgs.includes("existing-branch"), true);
  assertEquals(capturedArgs.includes("/test/worktrees/existing-branch"), true);
});

// =============================================================================
// removeWorktree tests
// =============================================================================

Deno.test("removeWorktree executes git worktree remove", async () => {
  let capturedArgs: string[] = [];

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        capturedArgs = opts.args as string[];
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        } as RunResult);
      },
    },
  });

  await removeWorktree(
    {
      worktreePath: "/test/worktrees/feature-branch",
    },
    ctx,
  );

  assertEquals(capturedArgs.includes("worktree"), true);
  assertEquals(capturedArgs.includes("remove"), true);
  assertEquals(capturedArgs.includes("/test/worktrees/feature-branch"), true);
  assertEquals(capturedArgs.includes("--force"), false);
});

Deno.test("removeWorktree executes git worktree remove --force with force option", async () => {
  let capturedArgs: string[] = [];

  const ctx = createMockContext({
    process: {
      run: (opts) => {
        capturedArgs = opts.args as string[];
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        } as RunResult);
      },
    },
  });

  await removeWorktree(
    {
      worktreePath: "/test/worktrees/feature-branch",
      force: true,
    },
    ctx,
  );

  assertEquals(capturedArgs.includes("worktree"), true);
  assertEquals(capturedArgs.includes("remove"), true);
  assertEquals(capturedArgs.includes("/test/worktrees/feature-branch"), true);
  assertEquals(capturedArgs.includes("--force"), true);
});

// =============================================================================
// getCreateWorktreeCommand tests
// =============================================================================

Deno.test("getCreateWorktreeCommand returns command with -b for new branch", () => {
  const command = getCreateWorktreeCommand({
    branchName: "feature-new",
    worktreePath: "/test/worktrees/feature-new",
    branchExists: false,
  });

  assertEquals(command, "git worktree add -b feature-new '/test/worktrees/feature-new'");
});

Deno.test("getCreateWorktreeCommand returns command without -b for existing branch", () => {
  const command = getCreateWorktreeCommand({
    branchName: "existing-branch",
    worktreePath: "/test/worktrees/existing-branch",
    branchExists: true,
  });

  assertEquals(command, "git worktree add '/test/worktrees/existing-branch' existing-branch");
});
