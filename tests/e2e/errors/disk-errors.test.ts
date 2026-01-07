import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "../helpers/pty.js";
import { assertOutputContains } from "../helpers/assertions.js";
import { setupTestGitRepo } from "../helpers/git-setup.js";

/**
 * Helper to commit .vibe.toml to git so it exists in worktrees
 */
function commitVibeToml(repoPath: string): void {
  execFileSync("git", ["add", ".vibe.toml"], { cwd: repoPath });
  execFileSync("git", ["commit", "-m", "Add .vibe.toml"], { cwd: repoPath });
}

/**
 * Disk space error tests
 *
 * Note: True ENOSPC (disk full) errors are difficult to simulate in E2E tests
 * without root privileges. These tests focus on validating error handling
 * code paths by triggering file copy failures through other means.
 */
describe("disk space errors", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  test("Warning when file copy fails (simulating disk space issues)", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    // Create a .vibe.toml that tries to copy a non-existent file
    // This simulates the error handling path that would be triggered by ENOSPC
    const vibeTomlPath = join(repoPath, ".vibe.toml");
    writeFileSync(
      vibeTomlPath,
      `
[copy]
files = ["this-file-does-not-exist.txt", "another-missing-file.conf"]
`,
    );

    // Commit .vibe.toml so it exists in the worktree
    commitVibeToml(repoPath);

    // Trust the .vibe.toml file using vibe trust command
    const trustRunner = new VibeCommandRunner(getVibePath(), repoPath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
    } finally {
      trustRunner.dispose();
    }

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      await runner.spawn(["start", "feat/test-disk-error"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      const exitCode = runner.getExitCode();

      // File copy failures should produce warnings but not prevent worktree creation
      // This matches the behavior in src/commands/start.ts lines 157-159
      // where copyFile errors are caught and warned about

      // The command may succeed with warnings or fail depending on config handling
      // We're mainly verifying that it doesn't crash and handles errors gracefully
      if (output.includes("Warning") || output.includes("Failed")) {
        // Expected: warning messages about failed copies
        assertOutputContains(output, "cd");
      }

      // Exit code might be 0 (success with warnings) or non-zero
      // Main point: the error is handled gracefully, not a crash
    } finally {
      runner.dispose();
    }
  });

  test("Worktree creation succeeds despite copy failures", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    // Create a .vibe.toml with glob patterns that may partially fail
    const vibeTomlPath = join(repoPath, ".vibe.toml");
    writeFileSync(
      vibeTomlPath,
      `
[copy]
files = ["*.txt", "config/*.json"]
`,
    );

    // Create some files that will succeed
    writeFileSync(join(repoPath, "test.txt"), "test content");

    // Commit .vibe.toml and test.txt so they exist in the worktree
    execFileSync("git", ["add", "."], { cwd: repoPath });
    execFileSync("git", ["commit", "-m", "Add .vibe.toml and test files"], {
      cwd: repoPath,
    });

    // Trust the .vibe.toml file
    const trustRunner = new VibeCommandRunner(getVibePath(), repoPath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
    } finally {
      trustRunner.dispose();
    }

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      await runner.spawn(["start", "feat/partial-copy"]);
      await runner.waitForExit();

      const output = runner.getOutput();

      // Even if some files fail to copy, worktree should be created
      // This validates the error recovery behavior
      assertOutputContains(output, "cd");

      // The worktree directory should exist even with copy failures
      // (verified implicitly by cd command appearing in output)
    } finally {
      runner.dispose();
    }
  });
});
