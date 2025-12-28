import { dirname } from "@std/path";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.ts";
import { setupTestGitRepo } from "./helpers/git-setup.ts";
import { assertExitCode, assertOutputContains } from "./helpers/assertions.ts";

Deno.test({
  name: "clean: Remove worktree when no uncommitted changes",
  async fn() {
    const { repoPath, cleanup } = await setupTestGitRepo();
    const vibePath = getVibePath();

    try {
      // Create a worktree first
      const parentDir = dirname(repoPath);
      const repoName = repoPath.split("/").pop()!;
      const worktreePath = `${parentDir}/${repoName}-feat-clean`;

      const createWorktree = new Deno.Command("git", {
        args: ["worktree", "add", "-b", "feat/clean", worktreePath],
        cwd: repoPath,
        stdout: "null",
        stderr: "null",
      });
      await createWorktree.output();

      // Run vibe clean from the worktree
      const runner = new VibeCommandRunner(vibePath, worktreePath);
      await runner.spawn(["clean"]);
      await runner.waitForExit();

      // Verify exit code
      assertExitCode(runner.getExitCode(), 0);

      const output = runner.getOutput();

      // Verify output contains cd command to main repo
      assertOutputContains(output, "cd");
      assertOutputContains(output, repoPath);

      runner.dispose();
    } finally {
      await cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "clean: Error when run from main worktree",
  async fn() {
    const { repoPath, cleanup } = await setupTestGitRepo();
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
      await cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
