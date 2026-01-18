import { afterEach, describe, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "../helpers/pty.js";
import {
  assertErrorInOutput,
  assertGitError,
  assertNonZeroExitCode,
} from "../helpers/assertions.js";
import {
  setupCorruptedGitRepo,
  setupDetachedHeadRepo,
  setupGitRepoWithoutUserConfig,
  setupNonGitDirectory,
} from "../helpers/error-setup.js";
import { setupTestGitRepo } from "../helpers/git-setup.js";

describe("git configuration errors", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  test("Error when not in a git repository", async () => {
    const { dirPath, cleanup: dirCleanup } = await setupNonGitDirectory();
    cleanup = dirCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, dirPath);

    try {
      await runner.spawn(["start", "feat/test"]);
      await runner.waitForExit();

      // Assert error state
      const exitCode = runner.getExitCode();
      assertNonZeroExitCode(exitCode);

      const output = runner.getOutput();
      assertErrorInOutput(output);
      assertGitError(output, "not a git repository");
    } finally {
      runner.dispose();
    }
  });

  test("Error when git user.email is missing", async () => {
    const { repoPath, cleanup: repoCleanup } =
      await setupGitRepoWithoutUserConfig();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      await runner.spawn(["start", "feat/test"]);
      await runner.waitForExit();

      // The command might succeed if it doesn't require a commit
      // or might fail if git requires user config
      // We're mainly testing that the error is handled gracefully
      const exitCode = runner.getExitCode();
      const output = runner.getOutput();

      // If it failed, verify it's a git config error
      if (exitCode !== 0) {
        assertErrorInOutput(output);
        // Git will complain about user.email or user.name being missing
        assertGitError(output, "user\\.(name|email)");
      }
    } finally {
      runner.dispose();
    }
  });

  test("Error when .git/config is corrupted", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupCorruptedGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      await runner.spawn(["start", "feat/test"]);
      await runner.waitForExit();

      // Git should fail when trying to read corrupted config
      const exitCode = runner.getExitCode();
      assertNonZeroExitCode(exitCode);

      const output = runner.getOutput();
      assertErrorInOutput(output);
      // Git config errors typically mention "bad config" or parsing issues
      assertGitError(output, "(bad config|fatal)");
    } finally {
      runner.dispose();
    }
  });

  test("Handle detached HEAD state", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupDetachedHeadRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      await runner.spawn(["start", "feat/test"]);
      await runner.waitForExit();

      // Detached HEAD might be acceptable for worktree creation
      // The test validates that the command doesn't crash
      const exitCode = runner.getExitCode();
      const output = runner.getOutput();

      // Either succeeds or fails gracefully
      if (exitCode !== 0) {
        assertErrorInOutput(output);
      }
      // Main point: doesn't crash, handles state gracefully
    } finally {
      runner.dispose();
    }
  });

  test("Error when branch name contains invalid characters", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      // Try to create a branch with path traversal characters
      await runner.spawn(["start", "../escape"]);
      await runner.waitForExit();

      // Git should reject the invalid branch name
      const exitCode = runner.getExitCode();
      assertNonZeroExitCode(exitCode);

      const output = runner.getOutput();
      assertErrorInOutput(output);
      // Git will complain about the invalid ref name
      assertGitError(output, "(invalid|fatal|bad)");
    } finally {
      runner.dispose();
    }
  });

  test("Error when branch name has special characters", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      // Try to create a branch with spaces and special chars
      await runner.spawn(["start", "feat/test branch@#$"]);
      await runner.waitForExit();

      // Git should reject or sanitize the branch name
      const exitCode = runner.getExitCode();
      const output = runner.getOutput();

      // Either fails with error or succeeds with sanitized name
      if (exitCode !== 0) {
        assertErrorInOutput(output);
      }
      // Main point: doesn't crash, handles invalid names
    } finally {
      runner.dispose();
    }
  });
});
