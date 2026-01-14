import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.js";
import { setupTestGitRepo } from "./helpers/git-setup.js";
import { assertExitCode, assertOutputContains } from "./helpers/assertions.js";

function branchExists(repoPath: string, branchName: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd: repoPath,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

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

      // Verify output contains success message
      assertOutputContains(output, "has been removed");

      // Verify worktree directory no longer exists
      expect(existsSync(worktreePath)).toBe(false);
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

  test("Delete branch with --delete-branch option", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create a worktree first
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-delete`;
    const branchName = "feat/delete";

    execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Verify branch exists
    expect(branchExists(repoPath, branchName)).toBe(true);

    // Run vibe clean with --delete-branch
    const runner = new VibeCommandRunner(vibePath, worktreePath);
    try {
      await runner.spawn(["clean", "--delete-branch"]);
      await runner.waitForExit();

      assertExitCode(runner.getExitCode(), 0);

      const output = runner.getOutput();
      assertOutputContains(output, "has been removed");
      assertOutputContains(output, "has been deleted");

      // Verify worktree directory no longer exists
      expect(existsSync(worktreePath)).toBe(false);

      // Verify branch no longer exists
      expect(branchExists(repoPath, branchName)).toBe(false);
    } finally {
      runner.dispose();
    }
  });

  test("Keep branch with --keep-branch option even when config has delete_branch=true", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create .vibe.toml with delete_branch=true
    const vibeConfigPath = join(repoPath, ".vibe.toml");
    writeFileSync(vibeConfigPath, "[clean]\ndelete_branch = true\n");
    execFileSync("git", ["add", ".vibe.toml"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add vibe config"], { cwd: repoPath, stdio: "pipe" });

    // Create a worktree
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-keep`;
    const branchName = "feat/keep";

    execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Trust the config from worktree path (trust is path-based)
    const trustRunner = new VibeCommandRunner(vibePath, worktreePath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
    } finally {
      trustRunner.dispose();
    }

    // Verify branch exists
    expect(branchExists(repoPath, branchName)).toBe(true);

    // Run vibe clean with --keep-branch (should override config)
    const runner = new VibeCommandRunner(vibePath, worktreePath);
    try {
      await runner.spawn(["clean", "--keep-branch"]);
      await runner.waitForExit();

      assertExitCode(runner.getExitCode(), 0);

      // Verify worktree directory no longer exists
      expect(existsSync(worktreePath)).toBe(false);

      // Verify branch still exists (--keep-branch overrides config)
      expect(branchExists(repoPath, branchName)).toBe(true);
    } finally {
      runner.dispose();
    }
  });

  test("Delete branch when config has delete_branch=true", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create .vibe.toml with delete_branch=true
    const vibeConfigPath = join(repoPath, ".vibe.toml");
    writeFileSync(vibeConfigPath, "[clean]\ndelete_branch = true\n");
    execFileSync("git", ["add", ".vibe.toml"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add vibe config"], { cwd: repoPath, stdio: "pipe" });

    // Create a worktree
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-config`;
    const branchName = "feat/config";

    execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Trust the config from worktree path (trust is path-based)
    const trustRunner = new VibeCommandRunner(vibePath, worktreePath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
    } finally {
      trustRunner.dispose();
    }

    // Verify branch exists
    expect(branchExists(repoPath, branchName)).toBe(true);

    // Run vibe clean (should use config)
    const runner = new VibeCommandRunner(vibePath, worktreePath);
    try {
      await runner.spawn(["clean"]);
      await runner.waitForExit();

      assertExitCode(runner.getExitCode(), 0);

      const output = runner.getOutput();
      assertOutputContains(output, "has been removed");
      assertOutputContains(output, "has been deleted");

      // Verify worktree directory no longer exists
      expect(existsSync(worktreePath)).toBe(false);

      // Verify branch no longer exists
      expect(branchExists(repoPath, branchName)).toBe(false);
    } finally {
      runner.dispose();
    }
  });
});
