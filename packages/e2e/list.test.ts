import { execFileSync } from "child_process";
import { join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.js";
import { setupTestGitRepo } from "./helpers/git-setup.js";
import { assertExitCode, assertOutputContains } from "./helpers/assertions.js";

/**
 * Add a worktree with `git` directly, so the listing is exercised against a
 * repository state built independently of `vibe start`.
 */
function addWorktree(repoPath: string, branch: string, dirName: string): string {
  const path = join(repoPath, "..", dirName);
  execFileSync("git", ["worktree", "add", "-b", branch, path], {
    cwd: repoPath,
    stdio: "pipe",
  });
  return path;
}

/** Strip PTY carriage returns and ANSI escapes so lines can be matched. */
function toLines(output: string): string[] {
  return output
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

describe("list command", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  test("Lists every worktree and marks the current one", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    addWorktree(repoPath, "feature/alpha", "vibe-e2e-list-alpha");

    const runner = new VibeCommandRunner(getVibePath(), repoPath, homePath);
    try {
      await runner.spawn(["list"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      // Both worktrees appear, with their branch names.
      assertOutputContains(output, "main");
      assertOutputContains(output, "feature/alpha");

      // Exactly one row is marked, and it is the main worktree we ran from.
      const marked = toLines(output).filter((line) => line.startsWith("*"));
      expect(marked).toHaveLength(1);
      expect(marked[0]).toContain("main");
    } finally {
      runner.dispose();
    }
  });

  test("Marks the worktree the command is run from", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    const alphaPath = addWorktree(repoPath, "feature/alpha", "vibe-e2e-list-cwd");

    // Run from inside the secondary worktree: the marker must follow the cwd.
    const runner = new VibeCommandRunner(getVibePath(), alphaPath, homePath);
    try {
      await runner.spawn(["list"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const marked = toLines(output).filter((line) => line.startsWith("*"));
      expect(marked).toHaveLength(1);
      expect(marked[0]).toContain("feature/alpha");
    } finally {
      runner.dispose();
    }
  });

  test("--json emits a parseable array carrying every worktree", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    addWorktree(repoPath, "feature/alpha", "vibe-e2e-list-json");

    const runner = new VibeCommandRunner(getVibePath(), repoPath, homePath);
    try {
      await runner.spawn(["list", "--json"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const jsonMatch = output.replace(/\r/g, "").match(/\[[\s\S]*\]/);
      expect(jsonMatch).not.toBeNull();
      const parsed = JSON.parse(jsonMatch![0]) as {
        branch: string;
        path: string;
        current: boolean;
        scratch: boolean;
      }[];

      expect(parsed).toHaveLength(2);
      const branches = parsed.map((entry) => entry.branch).sort();
      expect(branches).toEqual(["feature/alpha", "main"]);
      // Exactly one entry is the current worktree, and it is `main`.
      const current = parsed.filter((entry) => entry.current);
      expect(current).toHaveLength(1);
      expect(current[0].branch).toBe("main");
      expect(parsed.every((entry) => entry.scratch === false)).toBe(true);
    } finally {
      runner.dispose();
    }
  });

  test("Marks scratch worktrees so they are easy to spot", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    addWorktree(repoPath, "scratch/20260101120000", "vibe-e2e-list-scratch");

    const runner = new VibeCommandRunner(getVibePath(), repoPath, homePath);
    try {
      await runner.spawn(["list"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const scratchLine = toLines(output).find((line) => line.includes("scratch/20260101120000"));
      expect(scratchLine).toBeDefined();
      expect(scratchLine).toContain("(scratch)");
    } finally {
      runner.dispose();
    }
  });
});
