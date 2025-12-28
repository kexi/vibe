import { execSync } from "child_process";
import { dirname } from "path";
import { afterEach, describe, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.js";
import { setupTestGitRepo } from "./helpers/git-setup.js";
import {
  assertDirectoryExists,
  assertExitCode,
  assertOutputContains,
} from "./helpers/assertions.js";

describe("start command", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  test("Create worktree with new branch", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      // Run vibe start feat/new-feature
      await runner.spawn(["start", "feat/new-feature"]);
      await runner.waitForExit();

      // Verify exit code
      assertExitCode(runner.getExitCode(), 0);

      const output = runner.getOutput();

      // Verify output contains cd command
      assertOutputContains(output, "cd");

      // Verify worktree was created
      const parentDir = dirname(repoPath);
      const repoName = repoPath.split("/").pop()!;
      const worktreePath = `${parentDir}/${repoName}-feat-new-feature`;

      await assertDirectoryExists(worktreePath);
    } finally {
      runner.dispose();
    }
  });

  test("Use --reuse flag with existing branch", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    try {
      // Create an existing branch
      execSync("git checkout -b existing-branch", {
        cwd: repoPath,
        stdio: "pipe",
      });
      execSync("git checkout main", {
        cwd: repoPath,
        stdio: "pipe",
      });

      // Run vibe start existing-branch --reuse
      const runner = new VibeCommandRunner(vibePath, repoPath);
      await runner.spawn(["start", "existing-branch", "--reuse"]);
      await runner.waitForExit();

      // Verify exit code
      assertExitCode(runner.getExitCode(), 0);

      const output = runner.getOutput();

      // Verify output contains cd command
      assertOutputContains(output, "cd");

      // Verify worktree was created
      const parentDir = dirname(repoPath);
      const repoName = repoPath.split("/").pop()!;
      const worktreePath = `${parentDir}/${repoName}-existing-branch`;

      await assertDirectoryExists(worktreePath);

      runner.dispose();
    } catch (error) {
      throw error;
    }
  });

  test("Error when branch name is missing", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      // Run vibe start without branch name
      await runner.spawn(["start"]);
      await runner.waitForExit();

      // Verify exit code is non-zero
      const exitCode = runner.getExitCode();
      if (exitCode === 0) {
        throw new Error(
          "Expected non-zero exit code when branch name is missing",
        );
      }

      const output = runner.getOutput();

      // Verify error message
      assertOutputContains(output, "Error");
    } finally {
      runner.dispose();
    }
  });
});
