import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.js";
import { setupTestGitRepo } from "./helpers/git-setup.js";
import { assertExitCode, assertOutputContains, waitForCondition } from "./helpers/assertions.js";

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
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
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
    const runner = new VibeCommandRunner(vibePath, worktreePath, homePath);
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

  test("Remove worktree with uncommitted changes using --force", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create a worktree first
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-force`;

    execFileSync("git", ["worktree", "add", "-b", "feat/force", worktreePath], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Create uncommitted changes in the worktree
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: worktreePath,
      stdio: "pipe",
    });
    execFileSync("git", ["config", "user.name", "Test User"], {
      cwd: worktreePath,
      stdio: "pipe",
    });
    const fs = await import("fs");
    fs.writeFileSync(`${worktreePath}/uncommitted.txt`, "uncommitted changes");

    // Run vibe clean with --force from the worktree
    const runner = new VibeCommandRunner(vibePath, worktreePath, homePath);
    try {
      await runner.spawn(["clean", "--force"]);
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
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);

    try {
      // Run vibe clean from main worktree (should fail)
      await runner.spawn(["clean"]);
      await runner.waitForExit();

      // Verify exit code is non-zero
      const exitCode = runner.getExitCode();
      if (exitCode === 0) {
        throw new Error("Expected non-zero exit code when running clean from main worktree");
      }

      const output = runner.getOutput();

      // Verify error message
      assertOutputContains(output, "Error");
    } finally {
      runner.dispose();
    }
  });

  test("Delete branch with --delete-branch option", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
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
    const runner = new VibeCommandRunner(vibePath, worktreePath, homePath);
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
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
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
    const trustRunner = new VibeCommandRunner(vibePath, worktreePath, homePath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
      const trustOutput = trustRunner.getOutput();
      assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
    } finally {
      trustRunner.dispose();
    }

    // Wait for trust configuration to be synced before proceeding
    await waitForCondition(() => existsSync(join(worktreePath, ".vibe.toml")), {
      timeout: 5000,
      interval: 100,
    });

    // Verify trust was successful before proceeding
    const verifyRunner = new VibeCommandRunner(vibePath, worktreePath, homePath);
    try {
      await verifyRunner.spawn(["verify"]);
      await verifyRunner.waitForExit();
      const verifyOutput = verifyRunner.getOutput();
      assertExitCode(verifyRunner.getExitCode(), 0, verifyOutput);
    } finally {
      verifyRunner.dispose();
    }

    // Additional sync wait for trust configuration persistence
    await waitForCondition(() => existsSync(join(worktreePath, ".vibe.toml")), {
      timeout: 5000,
      interval: 100,
    });

    // Verify branch exists
    expect(branchExists(repoPath, branchName)).toBe(true);

    // Run vibe clean with --keep-branch (should override config)
    const runner = new VibeCommandRunner(vibePath, worktreePath, homePath);
    try {
      await runner.spawn(["clean", "--keep-branch"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      // Verify worktree directory no longer exists
      expect(existsSync(worktreePath)).toBe(false);

      // Verify branch still exists (--keep-branch overrides config)
      expect(branchExists(repoPath, branchName)).toBe(true);
    } finally {
      runner.dispose();
    }
  });

  test("Delete branch when config has delete_branch=true", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
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
    const trustRunner = new VibeCommandRunner(vibePath, worktreePath, homePath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
      const trustOutput = trustRunner.getOutput();
      assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
    } finally {
      trustRunner.dispose();
    }

    // Wait for trust configuration to be synced before proceeding
    await waitForCondition(() => existsSync(join(worktreePath, ".vibe.toml")), {
      timeout: 5000,
      interval: 100,
    });

    // Verify trust was successful before proceeding
    const verifyRunner = new VibeCommandRunner(vibePath, worktreePath, homePath);
    try {
      await verifyRunner.spawn(["verify"]);
      await verifyRunner.waitForExit();
      const verifyOutput = verifyRunner.getOutput();
      assertExitCode(verifyRunner.getExitCode(), 0, verifyOutput);
    } finally {
      verifyRunner.dispose();
    }

    // Additional sync wait - verify trust is stable with a second check
    const verifyRunner2 = new VibeCommandRunner(vibePath, worktreePath, homePath);
    try {
      await verifyRunner2.spawn(["verify"]);
      await verifyRunner2.waitForExit();
      assertExitCode(verifyRunner2.getExitCode(), 0, verifyRunner2.getOutput());
    } finally {
      verifyRunner2.dispose();
    }

    // Verify branch exists
    expect(branchExists(repoPath, branchName)).toBe(true);

    // Run vibe clean (should use config)
    const runner = new VibeCommandRunner(vibePath, worktreePath, homePath);
    try {
      await runner.spawn(["clean"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

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

  test("Error when --delete-branch and --keep-branch are used together", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create a worktree first
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-exclusive`;

    execFileSync("git", ["worktree", "add", "-b", "feat/exclusive", worktreePath], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Run vibe clean with both --delete-branch and --keep-branch (should fail)
    const runner = new VibeCommandRunner(vibePath, worktreePath, homePath);
    try {
      await runner.spawn(["clean", "--delete-branch", "--keep-branch"]);
      await runner.waitForExit();

      // Verify exit code is non-zero
      const exitCode = runner.getExitCode();
      expect(exitCode).not.toBe(0);

      const output = runner.getOutput();

      // Verify error message about mutually exclusive options
      assertOutputContains(output, "--delete-branch and --keep-branch cannot be used together");

      // Verify worktree still exists (command should have failed before removal)
      expect(existsSync(worktreePath)).toBe(true);
    } finally {
      runner.dispose();
      // Clean up the worktree manually since the command failed
      try {
        execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
          cwd: repoPath,
          stdio: "pipe",
        });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  test("Clean worktree with large files", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-large`;

    execFileSync("git", ["worktree", "add", "-b", "feat/large", worktreePath], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Create a large file (1MB) to verify background deletion handles it
    const largeContent = "x".repeat(1024 * 1024);
    writeFileSync(join(worktreePath, "large-file.txt"), largeContent);

    const runner = new VibeCommandRunner(vibePath, worktreePath, homePath);
    try {
      await runner.spawn(["clean", "--force"]);
      await runner.waitForExit();

      assertExitCode(runner.getExitCode(), 0);

      const output = runner.getOutput();
      assertOutputContains(output, "has been removed");

      // Verify worktree directory no longer exists
      expect(existsSync(worktreePath)).toBe(false);
    } finally {
      runner.dispose();
    }
  });
});
