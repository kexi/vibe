import { execFileSync } from "child_process";
import { mkdirSync } from "fs";
import { basename, dirname } from "path";
import { afterEach, describe, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.js";
import { setupTestGitRepo } from "./helpers/git-setup.js";
import {
  assertDirectoryExists,
  assertExitCode,
  assertOutputContains,
} from "./helpers/assertions.js";

/**
 * Interactive prompt tests
 *
 * These tests exercise the PTY infrastructure (waitForPattern, write) by testing
 * interactive prompts. The VIBE_FORCE_INTERACTIVE environment variable is set in
 * pty.ts to bypass Deno.stdin.isTerminal() checks, allowing prompts to work in
 * the PTY environment.
 */
describe("interactive prompts", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  test("Navigate to existing worktree when branch in use (Y response)", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Step 1: Create a worktree with branch "feat/test"
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-test`;

    const runner1 = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner1.spawn(["start", "feat/test"]);
      await runner1.waitForExit();
      assertExitCode(runner1.getExitCode(), 0);
    } finally {
      runner1.dispose();
    }

    // Step 2: Try to create the same branch again (should prompt)
    const runner2 = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      // Await spawn to ensure PTY is ready before continuing
      await runner2.spawn(["start", "feat/test"]);

      // Wait for the prompt about branch being in use
      const promptFound = await runner2.waitForPattern(/Navigate to the existing worktree/, 15000);
      if (!promptFound) {
        const output = runner2.getOutput();
        throw new Error(`Expected prompt about branch being in use. Output:\n${output}`);
      }

      // Respond with Y to navigate to existing worktree
      runner2.write("Y\n");

      await runner2.waitForExit();

      // Verify output contains cd to existing worktree (use basename to avoid /private prefix issues on macOS)
      const output = runner2.getOutput();
      const worktreeName = `${repoName}-feat-test`;
      assertOutputContains(output, `cd `);
      assertOutputContains(output, worktreeName);
      assertExitCode(runner2.getExitCode(), 0, output);
    } finally {
      runner2.dispose();
    }
  });

  test("Cancel when branch in use (n response)", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Step 1: Create a worktree with branch "feat/test"
    const runner1 = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner1.spawn(["start", "feat/test"]);
      await runner1.waitForExit();
      assertExitCode(runner1.getExitCode(), 0);
    } finally {
      runner1.dispose();
    }

    // Step 2: Try to create the same branch again and cancel
    const runner2 = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner2.spawn(["start", "feat/test"]);

      // Wait for the prompt
      const promptFound = await runner2.waitForPattern(/Navigate to the existing worktree/, 15000);
      if (!promptFound) {
        const output = runner2.getOutput();
        throw new Error(`Expected prompt about branch being in use. Output:\n${output}`);
      }

      // Respond with n to cancel
      runner2.write("n\n");

      await runner2.waitForExit();

      // Verify output contains cancellation message
      const output = runner2.getOutput();
      assertOutputContains(output, "Cancelled");
      assertExitCode(runner2.getExitCode(), 0, output);
    } finally {
      runner2.dispose();
    }
  });

  test("Overwrite existing directory (choice 1)", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Step 1: Create a worktree
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-overwrite`;

    const runner1 = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner1.spawn(["start", "feat/overwrite"]);
      await runner1.waitForExit();
      assertExitCode(runner1.getExitCode(), 0);
    } finally {
      runner1.dispose();
    }

    // Step 2: Checkout a different branch to free up the feat/* branch, then delete it
    // This makes the directory exist as a worktree, but the original branch is available
    const tempBranch = `temp-${worktreePath.split("-").pop()}`;
    execFileSync("git", ["checkout", "-b", tempBranch], { cwd: worktreePath, stdio: "pipe" });
    const originalBranch = `feat/${worktreePath.split("-").pop()}`;
    execFileSync("git", ["branch", "-D", originalBranch], { cwd: repoPath, stdio: "pipe" });

    // Step 3: Try to create the same worktree again (directory exists but branch is available)
    const runner2 = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner2.spawn(["start", "feat/overwrite"]);

      // Wait for directory exists prompt
      const promptFound = await runner2.waitForPattern(/Directory.*already exists/, 15000);
      if (!promptFound) {
        const output = runner2.getOutput();
        throw new Error(`Expected prompt about directory existing. Output:\n${output}`);
      }

      // Select option 1 (overwrite)
      runner2.write("1\n");

      await runner2.waitForExit();

      // Verify worktree was recreated (use basename to avoid /private prefix issues on macOS)
      const output = runner2.getOutput();
      const worktreeName = `${repoName}-feat-overwrite`;
      assertOutputContains(output, `cd `);
      assertOutputContains(output, worktreeName);
      assertExitCode(runner2.getExitCode(), 0, output);
    } finally {
      runner2.dispose();
    }
  });

  test("Reuse existing directory (choice 2)", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Step 1: Create a worktree
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-reuse`;

    const runner1 = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner1.spawn(["start", "feat/reuse"]);
      await runner1.waitForExit();
      assertExitCode(runner1.getExitCode(), 0);
    } finally {
      runner1.dispose();
    }

    // Step 2: Checkout a different branch to free up the feat/* branch, then delete it
    // This makes the directory exist as a worktree, but the original branch is available
    const tempBranch = `temp-${worktreePath.split("-").pop()}`;
    execFileSync("git", ["checkout", "-b", tempBranch], { cwd: worktreePath, stdio: "pipe" });
    const originalBranch = `feat/${worktreePath.split("-").pop()}`;
    execFileSync("git", ["branch", "-D", originalBranch], { cwd: repoPath, stdio: "pipe" });

    // Step 3: Try to create the same worktree again and reuse
    const runner2 = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner2.spawn(["start", "feat/reuse"]);

      // Wait for directory exists prompt
      const promptFound = await runner2.waitForPattern(/Directory.*already exists/, 15000);
      if (!promptFound) {
        const output = runner2.getOutput();
        throw new Error(`Expected prompt about directory existing. Output:\n${output}`);
      }

      // Select option 2 (reuse)
      runner2.write("2\n");

      await runner2.waitForExit();

      // Verify output contains cd command (use basename to avoid /private prefix issues on macOS)
      const output = runner2.getOutput();
      const worktreeName = `${repoName}-feat-reuse`;
      assertOutputContains(output, `cd `);
      assertOutputContains(output, worktreeName);
      assertExitCode(runner2.getExitCode(), 0, output);
    } finally {
      runner2.dispose();
    }
  });

  test("Cancel when directory exists (choice 3)", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Step 1: Create a worktree
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-cancel`;

    const runner1 = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner1.spawn(["start", "feat/cancel"]);
      await runner1.waitForExit();
      assertExitCode(runner1.getExitCode(), 0);
    } finally {
      runner1.dispose();
    }

    // Step 2: Checkout a different branch to free up the feat/* branch, then delete it
    // This makes the directory exist as a worktree, but the original branch is available
    const tempBranch = `temp-${worktreePath.split("-").pop()}`;
    execFileSync("git", ["checkout", "-b", tempBranch], { cwd: worktreePath, stdio: "pipe" });
    const originalBranch = `feat/${worktreePath.split("-").pop()}`;
    execFileSync("git", ["branch", "-D", originalBranch], { cwd: repoPath, stdio: "pipe" });

    // Step 3: Try to create the same worktree again and cancel
    const runner2 = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner2.spawn(["start", "feat/cancel"]);

      // Wait for directory exists prompt
      const promptFound = await runner2.waitForPattern(/Directory.*already exists/, 15000);
      if (!promptFound) {
        const output = runner2.getOutput();
        throw new Error(`Expected prompt about directory existing. Output:\n${output}`);
      }

      // Select option 3 (cancel)
      runner2.write("3\n");

      await runner2.waitForExit();

      // Verify cancellation message
      const output = runner2.getOutput();
      assertOutputContains(output, "Cancelled");
      assertExitCode(runner2.getExitCode(), 0, output);
    } finally {
      runner2.dispose();
    }
  });

  test("Handle invalid input gracefully in confirmation", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Step 1: Create a worktree
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-invalid`;

    const runner1 = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner1.spawn(["start", "feat/invalid"]);
      await runner1.waitForExit();
      assertExitCode(runner1.getExitCode(), 0);
    } finally {
      runner1.dispose();
    }

    // Step 2: Try again with invalid input then valid input
    const runner2 = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner2.spawn(["start", "feat/invalid"]);

      // Wait for the prompt
      const promptFound = await runner2.waitForPattern(/Navigate to the existing worktree/, 15000);
      if (!promptFound) {
        const output = runner2.getOutput();
        throw new Error(`Expected prompt about branch being in use. Output:\n${output}`);
      }

      // Send invalid input first
      runner2.write("invalid\n");

      // Wait for error message about invalid input
      const errorFound = await runner2.waitForPattern(/Invalid input/, 10000);
      if (!errorFound) {
        const output = runner2.getOutput();
        throw new Error(`Expected invalid input message. Output:\n${output}`);
      }

      // Then send valid input
      runner2.write("Y\n");

      await runner2.waitForExit();

      // Verify successful navigation (use basename to avoid /private prefix issues on macOS)
      const output = runner2.getOutput();
      const worktreeName = `${repoName}-feat-invalid`;
      assertOutputContains(output, `cd `);
      assertOutputContains(output, worktreeName);
      assertExitCode(runner2.getExitCode(), 0, output);
    } finally {
      runner2.dispose();
    }
  });
});
