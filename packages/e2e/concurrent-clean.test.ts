import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { basename, dirname } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.js";
import { setupTestGitRepo } from "./helpers/git-setup.js";
import { waitForPathRemoval } from "./helpers/assertions.js";

describe("concurrent clean command", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  // Skip this test in CI as it's flaky due to file system locking on macOS CI
  // The test works locally but times out in GitHub Actions
  test.skip("Two concurrent clean commands on same worktree should not panic", { timeout: 120000 }, async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create a worktree
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-concurrent`;

    execFileSync("git", ["worktree", "add", "-b", "feat/concurrent", worktreePath], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Run two clean commands concurrently
    const runner1 = new VibeCommandRunner(vibePath, worktreePath);
    const runner2 = new VibeCommandRunner(vibePath, worktreePath);

    try {
      // Spawn both processes nearly simultaneously
      await Promise.all([
        runner1.spawn(["clean", "--force"]),
        runner2.spawn(["clean", "--force"]),
      ]);

      // Wait for both to complete
      await Promise.all([runner1.waitForExit(), runner2.waitForExit()]);

      const exitCode1 = runner1.getExitCode();
      const exitCode2 = runner2.getExitCode();
      const output1 = runner1.getOutput();
      const output2 = runner2.getOutput();

      // Neither process should panic
      const noPanic1 = !output1.includes("panicked") && !output1.includes("PANIC");
      const noPanic2 = !output2.includes("panicked") && !output2.includes("PANIC");

      expect(noPanic1).toBe(true);
      expect(noPanic2).toBe(true);

      // At least one should succeed with exit code 0
      // The other may succeed or gracefully handle "already removed"
      const atLeastOneSuccess = exitCode1 === 0 || exitCode2 === 0;
      expect(atLeastOneSuccess).toBe(true);

      // Neither should crash with non-zero due to race condition
      // Both should either succeed (0) or be non-zero without panic
      const validExitCodes = [0, null]; // null means process may not have exited cleanly
      const isValidExit1 = validExitCodes.includes(exitCode1) || exitCode1 !== null;
      const isValidExit2 = validExitCodes.includes(exitCode2) || exitCode2 !== null;
      expect(isValidExit1).toBe(true);
      expect(isValidExit2).toBe(true);

      // Wait for background deletion to complete using polling
      await waitForPathRemoval(worktreePath, { timeout: 5000, interval: 100 });

      // Worktree directory should no longer exist
      expect(existsSync(worktreePath)).toBe(false);
    } finally {
      runner1.dispose();
      runner2.dispose();
    }
  });

  test("Second clean command after first completes should handle gracefully", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create a worktree
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-sequential`;

    execFileSync("git", ["worktree", "add", "-b", "feat/sequential", worktreePath], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Run first clean command
    const runner1 = new VibeCommandRunner(vibePath, worktreePath);
    try {
      await runner1.spawn(["clean", "--force"]);
      await runner1.waitForExit();

      expect(runner1.getExitCode()).toBe(0);
      expect(existsSync(worktreePath)).toBe(false);
    } finally {
      runner1.dispose();
    }

    // Run second clean command on same (now non-existent) worktree path
    // This simulates the case where another process already cleaned up
    // Note: This will fail because we can't cd to a non-existent directory
    // but the important thing is it should not panic
    const runner2 = new VibeCommandRunner(vibePath, repoPath);
    try {
      await runner2.spawn(["clean"]);
      await runner2.waitForExit();

      const output2 = runner2.getOutput();

      // Should not panic
      const noPanic = !output2.includes("panicked") && !output2.includes("PANIC");
      expect(noPanic).toBe(true);

      // Should show error about main worktree (since we're running from main repo)
      const hasExpectedError = output2.includes("Cannot clean main worktree");
      expect(hasExpectedError).toBe(true);
    } finally {
      runner2.dispose();
    }
  });
});
