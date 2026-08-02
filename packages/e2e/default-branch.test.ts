import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { basename, dirname } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.js";
import { setupTestGitRepo } from "./helpers/git-setup.js";
import {
  assertExitCode,
  assertNonZeroExitCode,
  assertOutputContains,
} from "./helpers/assertions.js";

/**
 * Guards `vibe clean --delete-branch` and `vibe rename` against operating on the
 * repository's default branch (issue #578).
 *
 * `setupTestGitRepo` builds a repo with no remote, so the default branch is
 * resolved from `init.defaultBranch`; each test declares it explicitly rather
 * than relying on whatever the host's global git config happens to say.
 */

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });
}

function branchExists(repoPath: string, branchName: string): boolean {
  try {
    git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repoPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Add a worktree checked out on a NEW branch and return its path.
 */
function addWorktree(repoPath: string, branch: string, suffix: string): string {
  const worktreePath = `${dirname(repoPath)}/${basename(repoPath)}-${suffix}`;
  git(["worktree", "add", "-b", branch, worktreePath], repoPath);
  return worktreePath;
}

describe("default branch protection", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  test("clean --delete-branch removes the worktree but keeps the default branch", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    // A second worktree checked out on the default branch itself.
    git(["config", "init.defaultBranch", "protected-trunk"], repoPath);
    const worktreePath = addWorktree(repoPath, "protected-trunk", "trunk");

    const runner = new VibeCommandRunner(getVibePath(), worktreePath, homePath);
    try {
      await runner.spawn(["clean", "--delete-branch"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);
      // The worktree is still removed — only the branch deletion is skipped.
      assertOutputContains(output, "has been removed");
      assertOutputContains(output, "Skipped deleting branch protected-trunk");
      assertOutputContains(output, "--allow-default-branch");
      expect(existsSync(worktreePath)).toBe(false);
      expect(branchExists(repoPath, "protected-trunk")).toBe(true);
    } finally {
      runner.dispose();
    }
  });

  test("clean --delete-branch --allow-default-branch deletes the default branch", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    git(["config", "init.defaultBranch", "protected-trunk"], repoPath);
    const worktreePath = addWorktree(repoPath, "protected-trunk", "trunk-allowed");

    const runner = new VibeCommandRunner(getVibePath(), worktreePath, homePath);
    try {
      await runner.spawn(["clean", "--delete-branch", "--allow-default-branch"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);
      assertOutputContains(output, "Branch protected-trunk has been deleted");
      expect(branchExists(repoPath, "protected-trunk")).toBe(false);
    } finally {
      runner.dispose();
    }
  });

  test("clean --delete-branch still deletes a non-default branch", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    git(["config", "init.defaultBranch", "protected-trunk"], repoPath);
    const worktreePath = addWorktree(repoPath, "feat/ordinary", "ordinary");

    const runner = new VibeCommandRunner(getVibePath(), worktreePath, homePath);
    try {
      await runner.spawn(["clean", "--delete-branch"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);
      expect(branchExists(repoPath, "feat/ordinary")).toBe(false);
    } finally {
      runner.dispose();
    }
  });

  test("rename refuses to rename the default branch", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    git(["config", "init.defaultBranch", "protected-trunk"], repoPath);
    const worktreePath = addWorktree(repoPath, "protected-trunk", "rename-guard");

    const runner = new VibeCommandRunner(getVibePath(), worktreePath, homePath);
    try {
      await runner.spawn(["rename", "renamed-trunk"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertNonZeroExitCode(runner.getExitCode());
      assertOutputContains(output, "is this repository's default branch");
      assertOutputContains(output, "--allow-default-branch");
      // Nothing was mutated.
      expect(branchExists(repoPath, "protected-trunk")).toBe(true);
      expect(branchExists(repoPath, "renamed-trunk")).toBe(false);
      expect(existsSync(worktreePath)).toBe(true);
    } finally {
      runner.dispose();
    }
  });

  test("rename --allow-default-branch renames the default branch", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    git(["config", "init.defaultBranch", "protected-trunk"], repoPath);
    const worktreePath = addWorktree(repoPath, "protected-trunk", "rename-allowed");

    const runner = new VibeCommandRunner(getVibePath(), worktreePath, homePath);
    try {
      await runner.spawn(["rename", "renamed-trunk", "--allow-default-branch"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);
      assertOutputContains(output, "Renamed protected-trunk -> renamed-trunk");
      expect(branchExists(repoPath, "renamed-trunk")).toBe(true);
      expect(branchExists(repoPath, "protected-trunk")).toBe(false);
    } finally {
      runner.dispose();
    }
  });

  test("the default branch is read from origin/HEAD in preference to init.defaultBranch", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    // origin/HEAD says `main`; init.defaultBranch says something else. The
    // remote's answer must win, so renaming `main` is refused.
    git(["config", "init.defaultBranch", "not-the-default"], repoPath);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"], repoPath);
    git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repoPath);

    // `main` is checked out in the primary worktree, so park it in a secondary
    // one: check out an unrelated branch in the primary first.
    git(["checkout", "-b", "parking"], repoPath);
    const worktreePath = `${dirname(repoPath)}/${basename(repoPath)}-origin-head`;
    git(["worktree", "add", worktreePath, "main"], repoPath);

    const runner = new VibeCommandRunner(getVibePath(), worktreePath, homePath);
    try {
      await runner.spawn(["rename", "renamed-main"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertNonZeroExitCode(runner.getExitCode());
      assertOutputContains(output, "'main' is this repository's default branch");
      expect(branchExists(repoPath, "main")).toBe(true);
    } finally {
      runner.dispose();
    }
  });
});
