import { execFileSync } from "child_process";
import { basename, dirname } from "path";
import { afterEach, describe, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.js";
import { setupTestGitRepo } from "./helpers/git-setup.js";
import { assertExitCode, assertOutputContains } from "./helpers/assertions.js";

describe("clean command", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  test("Remove worktree when no uncommitted changes", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create a worktree first
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-clean`;

    execFileSync("git", ["worktree", "add", "-b", "feat/clean", worktreePath], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Run vibe clean from the worktree
    const runner = new VibeCommandRunner(vibePath, worktreePath);
    try {
      await runner.spawn(["clean"]);
      await runner.waitForExit();

      // Verify exit code
      assertExitCode(runner.getExitCode(), 0);

      const output = runner.getOutput();

      // Verify output contains cd command to main repo
      assertOutputContains(output, "cd");
      assertOutputContains(output, repoPath);
    } finally {
      runner.dispose();
    }
  });

  test("Error when run from main worktree", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      // Run vibe clean from main worktree (should fail)
      await runner.spawn(["clean"]);
      await runner.waitForExit();

      // Verify exit code is non-zero
      const exitCode = runner.getExitCode();
      if (exitCode === 0) {
        throw new Error(
          "Expected non-zero exit code when running clean from main worktree",
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
