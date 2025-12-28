import { dirname } from "@std/path";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.ts";
import { setupTestGitRepo } from "./helpers/git-setup.ts";
import {
  assertDirectoryExists,
  assertExitCode,
  assertOutputContains,
} from "./helpers/assertions.ts";

Deno.test({
  name: "start: Create worktree with new branch",
  async fn() {
    const { repoPath, cleanup } = await setupTestGitRepo();
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
      await cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "start: Use --reuse flag with existing branch",
  async fn() {
    const { repoPath, cleanup } = await setupTestGitRepo();
    const vibePath = getVibePath();

    try {
      // Create an existing branch
      const cmd = new Deno.Command("git", {
        args: ["checkout", "-b", "existing-branch"],
        cwd: repoPath,
        stdout: "null",
        stderr: "null",
      });
      await cmd.output();

      const checkoutMain = new Deno.Command("git", {
        args: ["checkout", "main"],
        cwd: repoPath,
        stdout: "null",
        stderr: "null",
      });
      await checkoutMain.output();

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
    } finally {
      await cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "start: Error when branch name is missing",
  async fn() {
    const { repoPath, cleanup } = await setupTestGitRepo();
    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      // Run vibe start without branch name
      await runner.spawn(["start"]);
      await runner.waitForExit();

      // Verify exit code is non-zero
      const exitCode = runner.getExitCode();
      if (exitCode === 0) {
        throw new Error("Expected non-zero exit code when branch name is missing");
      }

      const output = runner.getOutput();

      // Verify error message
      assertOutputContains(output, "Error");
    } finally {
      runner.dispose();
      await cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
