import { execFileSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.js";
import { setupTestGitRepo } from "./helpers/git-setup.js";
import {
  assertDirectoryExists,
  assertExitCode,
  assertOutputContains,
} from "./helpers/assertions.js";

describe("start command", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  test("Create worktree with new branch", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

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
      const repoName = basename(repoPath);
      const worktreePath = `${parentDir}/${repoName}-feat-new-feature`;

      await assertDirectoryExists(worktreePath);
    } finally {
      runner.dispose();
    }
  });

  test("Use --reuse flag with existing branch", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create an existing branch
    execFileSync("git", ["checkout", "-b", "existing-branch"], {
      cwd: repoPath,
      stdio: "pipe",
    });
    execFileSync("git", ["checkout", "main"], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Run vibe start existing-branch --reuse
    const runner = new VibeCommandRunner(vibePath, repoPath);
    try {
      await runner.spawn(["start", "existing-branch", "--reuse"]);
      await runner.waitForExit();

      // Verify exit code
      assertExitCode(runner.getExitCode(), 0);

      const output = runner.getOutput();

      // Verify output contains cd command
      assertOutputContains(output, "cd");

      // Verify worktree was created
      const parentDir = dirname(repoPath);
      const repoName = basename(repoPath);
      const worktreePath = `${parentDir}/${repoName}-existing-branch`;

      await assertDirectoryExists(worktreePath);
    } finally {
      runner.dispose();
    }
  });

  test("Error when branch name is missing", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      // Run vibe start without branch name
      await runner.spawn(["start"]);
      await runner.waitForExit();

      // Verify exit code is non-zero
      const exitCode = runner.getExitCode();
      if (exitCode === 0) {
        throw new Error(
          "Expected non-zero exit code when branch name is missing",
        );
      }

      const output = runner.getOutput();

      // Verify error message
      assertOutputContains(output, "Error");
    } finally {
      runner.dispose();
    }
  });

  test("--no-hooks skips pre-start and post-start hooks", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create .vibe.toml with hooks that create marker files
    const vibeToml = `
[hooks]
pre_start = ["touch $VIBE_WORKTREE_PATH/.pre-hook-ran"]
post_start = ["touch $VIBE_WORKTREE_PATH/.post-hook-ran"]
`;
    writeFileSync(join(repoPath, ".vibe.toml"), vibeToml);
    execFileSync("git", ["add", ".vibe.toml"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add .vibe.toml"], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Trust the config
    const trustRunner = new VibeCommandRunner(vibePath, repoPath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
      const trustOutput = trustRunner.getOutput();
      assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
    } finally {
      trustRunner.dispose();
    }

    // Run vibe start with --no-hooks
    const runner = new VibeCommandRunner(vibePath, repoPath);
    try {
      await runner.spawn(["start", "feat/test-no-hooks", "--no-hooks"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      // Verify worktree was created
      const parentDir = dirname(repoPath);
      const repoName = basename(repoPath);
      const worktreePath = `${parentDir}/${repoName}-feat-test-no-hooks`;

      await assertDirectoryExists(worktreePath);

      // Verify hooks were NOT executed (marker files should not exist)
      const preHookMarker = join(worktreePath, ".pre-hook-ran");
      const postHookMarker = join(worktreePath, ".post-hook-ran");

      expect(existsSync(preHookMarker)).toBe(false);
      expect(existsSync(postHookMarker)).toBe(false);
    } finally {
      runner.dispose();
    }
  });

  test("--no-copy skips file copying", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create an untracked file to be copied (not in git)
    writeFileSync(join(repoPath, ".env.local"), "SECRET=value\n");
    // Add .env.local to .gitignore so it's not tracked
    writeFileSync(join(repoPath, ".gitignore"), ".env.local\n");
    const vibeToml = `
[copy]
files = [".env.local"]
`;
    writeFileSync(join(repoPath, ".vibe.toml"), vibeToml);
    execFileSync("git", ["add", ".vibe.toml", ".gitignore"], {
      cwd: repoPath,
      stdio: "pipe",
    });
    execFileSync("git", ["commit", "-m", "Add .vibe.toml and .gitignore"], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Trust the config
    const trustRunner = new VibeCommandRunner(vibePath, repoPath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
      const trustOutput = trustRunner.getOutput();
      assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
    } finally {
      trustRunner.dispose();
    }

    // Run vibe start with --no-copy
    const runner = new VibeCommandRunner(vibePath, repoPath);
    try {
      await runner.spawn(["start", "feat/test-no-copy", "--no-copy"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      // Verify worktree was created
      const parentDir = dirname(repoPath);
      const repoName = basename(repoPath);
      const worktreePath = `${parentDir}/${repoName}-feat-test-no-copy`;

      await assertDirectoryExists(worktreePath);

      // Verify file was NOT copied (file is untracked, so it won't exist unless copied)
      const copiedFile = join(worktreePath, ".env.local");
      expect(existsSync(copiedFile)).toBe(false);
    } finally {
      runner.dispose();
    }
  });

  test("--no-hooks and --no-copy can be combined", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create an untracked file to be copied and .vibe.toml with both hooks and copy
    writeFileSync(join(repoPath, ".env.local"), "SECRET=value\n");
    writeFileSync(join(repoPath, ".gitignore"), ".env.local\n");
    const vibeToml = `
[copy]
files = [".env.local"]

[hooks]
post_start = ["touch $VIBE_WORKTREE_PATH/.hook-ran"]
`;
    writeFileSync(join(repoPath, ".vibe.toml"), vibeToml);
    execFileSync("git", ["add", ".vibe.toml", ".gitignore"], {
      cwd: repoPath,
      stdio: "pipe",
    });
    execFileSync("git", ["commit", "-m", "Add .vibe.toml"], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Trust the config
    const trustRunner = new VibeCommandRunner(vibePath, repoPath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
      const trustOutput = trustRunner.getOutput();
      assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
    } finally {
      trustRunner.dispose();
    }

    // Verify trust was successful before proceeding
    const verifyRunner = new VibeCommandRunner(vibePath, repoPath);
    try {
      await verifyRunner.spawn(["verify"]);
      await verifyRunner.waitForExit();
      const verifyOutput = verifyRunner.getOutput();
      assertExitCode(verifyRunner.getExitCode(), 0, verifyOutput);
    } finally {
      verifyRunner.dispose();
    }

    // Run vibe start with both --no-hooks and --no-copy
    const runner = new VibeCommandRunner(vibePath, repoPath);
    try {
      await runner.spawn([
        "start",
        "feat/test-combined",
        "--no-hooks",
        "--no-copy",
      ]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      // Verify worktree was created
      const parentDir = dirname(repoPath);
      const repoName = basename(repoPath);
      const worktreePath = `${parentDir}/${repoName}-feat-test-combined`;

      await assertDirectoryExists(worktreePath);

      // Verify neither hooks nor copy were executed
      const hookMarker = join(worktreePath, ".hook-ran");
      const copiedFile = join(worktreePath, ".env.local");

      expect(existsSync(hookMarker)).toBe(false);
      expect(existsSync(copiedFile)).toBe(false);
    } finally {
      runner.dispose();
    }
  });

  test("worktree.path_script in .vibe.toml determines worktree path", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const parentDir = dirname(repoPath);

    // Create a path script that outputs a custom path
    const customWorktreeDir = join(parentDir, "custom-worktrees");
    const scriptPath = join(repoPath, "worktree-path.sh");
    const scriptContent = `#!/bin/bash
echo "${customWorktreeDir}/\${VIBE_REPO_NAME}-\${VIBE_SANITIZED_BRANCH}"
`;
    writeFileSync(scriptPath, scriptContent);
    execFileSync("chmod", ["+x", scriptPath], { cwd: repoPath, stdio: "pipe" });

    // Create .vibe.toml with path_script
    const vibeToml = `
[worktree]
path_script = "./worktree-path.sh"
`;
    writeFileSync(join(repoPath, ".vibe.toml"), vibeToml);
    execFileSync("git", ["add", ".vibe.toml", "worktree-path.sh"], {
      cwd: repoPath,
      stdio: "pipe",
    });
    execFileSync("git", ["commit", "-m", "Add .vibe.toml with path_script"], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Trust the config
    const trustRunner = new VibeCommandRunner(vibePath, repoPath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
      const trustOutput = trustRunner.getOutput();
      assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
    } finally {
      trustRunner.dispose();
    }

    // Run vibe start
    const runner = new VibeCommandRunner(vibePath, repoPath);
    try {
      await runner.spawn(["start", "feat/custom-path"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      // Verify worktree was created at the custom path
      const repoName = basename(repoPath);
      const expectedWorktreePath = `${customWorktreeDir}/${repoName}-feat-custom-path`;

      await assertDirectoryExists(expectedWorktreePath);

      assertOutputContains(output, expectedWorktreePath);
    } finally {
      runner.dispose();
    }
  });

  test(".vibe.local.toml path_script takes precedence over .vibe.toml", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const parentDir = dirname(repoPath);

    // Create two path scripts with different outputs
    const baseWorktreeDir = join(parentDir, "base-worktrees");
    const localWorktreeDir = join(parentDir, "local-worktrees");

    const baseScriptPath = join(repoPath, "base-path.sh");
    writeFileSync(
      baseScriptPath,
      `#!/bin/bash\necho "${baseWorktreeDir}/\${VIBE_REPO_NAME}-\${VIBE_SANITIZED_BRANCH}"\n`,
    );
    execFileSync("chmod", ["+x", baseScriptPath], {
      cwd: repoPath,
      stdio: "pipe",
    });

    const localScriptPath = join(repoPath, "local-path.sh");
    writeFileSync(
      localScriptPath,
      `#!/bin/bash\necho "${localWorktreeDir}/\${VIBE_REPO_NAME}-\${VIBE_SANITIZED_BRANCH}"\n`,
    );
    execFileSync("chmod", ["+x", localScriptPath], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Create .vibe.toml with base path_script
    const vibeToml = `
[worktree]
path_script = "./base-path.sh"
`;
    writeFileSync(join(repoPath, ".vibe.toml"), vibeToml);

    // Create .vibe.local.toml with local path_script (should take precedence)
    const vibeLocalToml = `
[worktree]
path_script = "./local-path.sh"
`;
    writeFileSync(join(repoPath, ".vibe.local.toml"), vibeLocalToml);

    execFileSync(
      "git",
      ["add", ".vibe.toml", ".vibe.local.toml", "base-path.sh", "local-path.sh"],
      { cwd: repoPath, stdio: "pipe" },
    );
    execFileSync("git", ["commit", "-m", "Add config files with path_scripts"], {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Trust the configs
    const trustRunner = new VibeCommandRunner(vibePath, repoPath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
      const trustOutput = trustRunner.getOutput();
      assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
    } finally {
      trustRunner.dispose();
    }

    // Run vibe start
    const runner = new VibeCommandRunner(vibePath, repoPath);
    try {
      await runner.spawn(["start", "feat/precedence-test"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      // Verify worktree was created at the LOCAL path (not base)
      const repoName = basename(repoPath);
      const expectedWorktreePath = `${localWorktreeDir}/${repoName}-feat-precedence-test`;

      await assertDirectoryExists(expectedWorktreePath);

      assertOutputContains(output, expectedWorktreePath);

      // Verify it was NOT created at the base path
      const baseWorktreePath = `${baseWorktreeDir}/${repoName}-feat-precedence-test`;
      expect(existsSync(baseWorktreePath)).toBe(false);
    } finally {
      runner.dispose();
    }
  });
});
