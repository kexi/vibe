import { execFileSync } from "child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.js";
import { setupTestGitRepo } from "./helpers/git-setup.js";
import {
  assertDirectoryExists,
  assertExitCode,
  assertOutputContains,
  waitForCondition,
} from "./helpers/assertions.js";

function git(args: string[], cwd: string, homePath: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: homePath,
    },
    stdio: "pipe",
  });
}

async function trustConfig(vibePath: string, cwd: string, homePath: string): Promise<void> {
  const trustRunner = new VibeCommandRunner(vibePath, cwd, homePath);
  try {
    await trustRunner.spawn(["trust"]);
    await trustRunner.waitForExit();
    const trustOutput = trustRunner.getOutput();
    assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
  } finally {
    trustRunner.dispose();
  }
}

function createSubmoduleSource(
  homePath: string,
  name: string,
  markerFile: string,
): string {
  const sourcePath = join(homePath, `${name}-source`);
  mkdirSync(sourcePath, { recursive: true });
  git(["init"], sourcePath, homePath);
  git(["config", "user.email", "test@example.com"], sourcePath, homePath);
  git(["config", "user.name", "Test User"], sourcePath, homePath);
  git(["remote", "add", "origin", sourcePath], sourcePath, homePath);
  writeFileSync(join(sourcePath, "README.md"), `# ${name}\n`);
  writeFileSync(
    join(sourcePath, ".vibe.toml"),
    `[hooks]\npost_start = ["touch ${markerFile}"]\n[copy]\nfiles = [".env"]\n`,
  );
  git(["add", "README.md", ".vibe.toml"], sourcePath, homePath);
  git(["commit", "-m", `Add ${name} config`], sourcePath, homePath);
  git(["branch", "-M", "main"], sourcePath, homePath);
  return sourcePath;
}

function addSubmodule(
  repoPath: string,
  homePath: string,
  sourcePath: string,
  submodulePath: string,
): void {
  git(["config", "--global", "protocol.file.allow", "always"], repoPath, homePath);
  git(
    ["-c", "protocol.file.allow=always", "submodule", "add", sourcePath, submodulePath],
    repoPath,
    homePath,
  );
}

describe("start command", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  test("Create worktree with new branch", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);

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

  test("Create worktree with base branch", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create a base branch with a unique commit
    execFileSync("git", ["checkout", "-b", "base-branch"], {
      cwd: repoPath,
      stdio: "pipe",
    });
    writeFileSync(join(repoPath, "BASE_MARKER.txt"), "base\n");
    execFileSync("git", ["add", "BASE_MARKER.txt"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add base marker"], {
      cwd: repoPath,
      stdio: "pipe",
    });
    execFileSync("git", ["checkout", "main"], {
      cwd: repoPath,
      stdio: "pipe",
    });

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      // Run vibe start with --base
      await runner.spawn(["start", "feat/from-base", "--base", "base-branch"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const parentDir = dirname(repoPath);
      const repoName = basename(repoPath);
      const worktreePath = `${parentDir}/${repoName}-feat-from-base`;

      await assertDirectoryExists(worktreePath);

      // Verify worktree includes the base branch commit
      const markerPath = join(worktreePath, "BASE_MARKER.txt");
      expect(existsSync(markerPath)).toBe(true);

      // Verify upstream is NOT set (default --no-track behavior)
      const branchOutput = execFileSync("git", ["branch", "-vv"], {
        cwd: worktreePath,
        encoding: "utf-8",
      });
      const currentBranchLine = branchOutput.split("\n").find((line) => line.startsWith("*"));
      expect(currentBranchLine).toBeDefined();
      expect(currentBranchLine).not.toContain("[base-branch]");
    } finally {
      runner.dispose();
    }
  });

  test("Create worktree with base branch and --track", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create a base branch with a unique commit
    execFileSync("git", ["checkout", "-b", "base-branch-track"], {
      cwd: repoPath,
      stdio: "pipe",
    });
    writeFileSync(join(repoPath, "TRACK_MARKER.txt"), "track\n");
    execFileSync("git", ["add", "TRACK_MARKER.txt"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add track marker"], {
      cwd: repoPath,
      stdio: "pipe",
    });
    execFileSync("git", ["checkout", "main"], {
      cwd: repoPath,
      stdio: "pipe",
    });

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      // Run vibe start with --base and --track
      await runner.spawn(["start", "feat/tracked", "--base", "base-branch-track", "--track"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const parentDir = dirname(repoPath);
      const repoName = basename(repoPath);
      const worktreePath = `${parentDir}/${repoName}-feat-tracked`;

      await assertDirectoryExists(worktreePath);

      // Verify worktree includes the base branch commit
      const markerPath = join(worktreePath, "TRACK_MARKER.txt");
      expect(existsSync(markerPath)).toBe(true);

      // Verify upstream IS set (--track behavior)
      const branchOutput = execFileSync("git", ["branch", "-vv"], {
        cwd: worktreePath,
        encoding: "utf-8",
      });
      const currentBranchLine = branchOutput.split("\n").find((line) => line.startsWith("*"));
      expect(currentBranchLine).toBeDefined();
      expect(currentBranchLine).toContain("[base-branch-track]");
    } finally {
      runner.dispose();
    }
  });

  test("Use --reuse flag with existing branch", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
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
    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
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

  test("--force overwrites conflicting worktree without prompting", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath);
    const worktreePath = `${parentDir}/${repoName}-feat-force`;

    execFileSync("git", ["worktree", "add", "-b", "other", worktreePath], {
      cwd: repoPath,
      stdio: "pipe",
    });

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner.spawn(["start", "feat/force", "--force"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);
      assertOutputContains(output, "cd");
      expect(output).not.toContain("Overwrite");

      await assertDirectoryExists(worktreePath);
      const branch = execFileSync("git", ["branch", "--show-current"], {
        cwd: worktreePath,
        encoding: "utf-8",
      }).trim();
      expect(branch).toBe("feat/force");
    } finally {
      runner.dispose();
    }
  });

  test("Error when branch name is missing", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);

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
    }
  });

  test("--no-hooks skips pre-start and post-start hooks", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
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
    const trustRunner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
      const trustOutput = trustRunner.getOutput();
      assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
    } finally {
      trustRunner.dispose();
    }

    // Run vibe start with --no-hooks
    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
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
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
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
    const trustRunner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
      const trustOutput = trustRunner.getOutput();
      assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
    } finally {
      trustRunner.dispose();
    }

    // Run vibe start with --no-copy
    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
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

  // --- [copy] untracked / modified (issue #580) ---
  //
  // The names under test deliberately contain spaces and non-ASCII characters:
  // the implementation enumerates candidates with `git ls-files -z`, and a
  // newline-delimited listing (or the default `core.quotePath=true` octal
  // quoting) would mangle exactly these names. Only a real `git` + real binary
  // run proves the `-z` path end to end, which is why this lives in E2E.
  const SPACED_UNTRACKED = "my scratch note.txt";
  const NON_ASCII_UNTRACKED = "メモ 帳.txt";

  /**
   * Write `.vibe.toml`, commit it, and trust it — the common prelude for the
   * copy-source tests below.
   */
  async function commitAndTrustConfig(
    repoPath: string,
    homePath: string,
    vibePath: string,
    toml: string,
  ): Promise<void> {
    writeFileSync(join(repoPath, ".vibe.toml"), toml);
    execFileSync("git", ["add", ".vibe.toml"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add .vibe.toml"], {
      cwd: repoPath,
      stdio: "pipe",
    });
    await trustConfig(vibePath, repoPath, homePath);
  }

  function worktreePathFor(repoPath: string, branch: string): string {
    return `${dirname(repoPath)}/${basename(repoPath)}-${branch.replace(/\//g, "-")}`;
  }

  test("[copy] untracked carries over untracked files with spaces and non-ASCII names", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    const vibePath = getVibePath();

    // Untracked and NOT ignored: exactly what `--others --exclude-standard` lists.
    writeFileSync(join(repoPath, SPACED_UNTRACKED), "scratch\n");
    writeFileSync(join(repoPath, NON_ASCII_UNTRACKED), "メモ\n");
    // An ignored file must stay behind (`--exclude-standard`).
    writeFileSync(join(repoPath, ".gitignore"), "ignored.log\n");
    writeFileSync(join(repoPath, "ignored.log"), "noise\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: repoPath, stdio: "pipe" });

    await commitAndTrustConfig(
      repoPath,
      homePath,
      vibePath,
      "[copy]\nuntracked = true\n",
    );

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner.spawn(["start", "feat/copy-untracked"]);
      await runner.waitForExit();
      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const worktreePath = worktreePathFor(repoPath, "feat/copy-untracked");
      await assertDirectoryExists(worktreePath);

      expect(readFileSync(join(worktreePath, SPACED_UNTRACKED), "utf-8")).toBe("scratch\n");
      expect(readFileSync(join(worktreePath, NON_ASCII_UNTRACKED), "utf-8")).toBe("メモ\n");
      // Ignored files are not "untracked" for this purpose.
      expect(existsSync(join(worktreePath, "ignored.log"))).toBe(false);
    } finally {
      runner.dispose();
    }
  });

  test("[copy] modified carries over locally modified tracked files", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    const vibePath = getVibePath();

    // A committed file with a name that needs -z, then modified in the worktree.
    const tracked = "docs/設計 メモ.md";
    mkdirSync(join(repoPath, "docs"), { recursive: true });
    writeFileSync(join(repoPath, tracked), "original\n");
    const untouched = "docs/untouched.md";
    writeFileSync(join(repoPath, untouched), "untouched\n");
    execFileSync("git", ["add", "docs"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add docs"], { cwd: repoPath, stdio: "pipe" });
    writeFileSync(join(repoPath, tracked), "work in progress\n");

    await commitAndTrustConfig(repoPath, homePath, vibePath, "[copy]\nmodified = true\n");

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner.spawn(["start", "feat/copy-modified"]);
      await runner.waitForExit();
      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const worktreePath = worktreePathFor(repoPath, "feat/copy-modified");
      await assertDirectoryExists(worktreePath);

      // The dirty version overwrote the committed one in the new worktree...
      expect(readFileSync(join(worktreePath, tracked), "utf-8")).toBe("work in progress\n");
      // ...while an unmodified tracked file is just whatever git checked out.
      expect(readFileSync(join(worktreePath, untouched), "utf-8")).toBe("untouched\n");
    } finally {
      runner.dispose();
    }
  });

  test("--copy-untracked enables the source without any config", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    const vibePath = getVibePath();

    writeFileSync(join(repoPath, SPACED_UNTRACKED), "scratch\n");

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      // No `.vibe.toml` at all: the flag alone must carry the file over.
      await runner.spawn(["start", "feat/flag-untracked", "--copy-untracked"]);
      await runner.waitForExit();
      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const worktreePath = worktreePathFor(repoPath, "feat/flag-untracked");
      await assertDirectoryExists(worktreePath);
      expect(readFileSync(join(worktreePath, SPACED_UNTRACKED), "utf-8")).toBe("scratch\n");
    } finally {
      runner.dispose();
    }
  });

  test("[copy] untracked sees files a pre_start hook created", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    const vibePath = getVibePath();

    // The documented order is pre_start -> copy -> post_start, so a file the
    // hook writes into the origin repo must be enumerated by the copy step that
    // follows it. `git ls-files` cannot report it before the hook has run.
    await commitAndTrustConfig(
      repoPath,
      homePath,
      vibePath,
      '[copy]\nuntracked = true\n\n[hooks]\npre_start = ["echo generated-by-hook > hook-made.txt"]\n',
    );

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner.spawn(["start", "feat/hook-created"]);
      await runner.waitForExit();
      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      // The hook really did write into the origin repo.
      expect(existsSync(join(repoPath, "hook-made.txt"))).toBe(true);

      const worktreePath = worktreePathFor(repoPath, "feat/hook-created");
      await assertDirectoryExists(worktreePath);
      expect(readFileSync(join(worktreePath, "hook-made.txt"), "utf-8")).toBe(
        "generated-by-hook\n",
      );
    } finally {
      runner.dispose();
    }
  });

  test("--no-copy suppresses [copy] untracked and modified", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    const vibePath = getVibePath();

    writeFileSync(join(repoPath, SPACED_UNTRACKED), "scratch\n");
    writeFileSync(join(repoPath, "README.md"), "# Modified\n");

    await commitAndTrustConfig(
      repoPath,
      homePath,
      vibePath,
      "[copy]\nuntracked = true\nmodified = true\n",
    );

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner.spawn(["start", "feat/no-copy-wins", "--no-copy"]);
      await runner.waitForExit();
      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const worktreePath = worktreePathFor(repoPath, "feat/no-copy-wins");
      await assertDirectoryExists(worktreePath);

      // The untracked file never arrives, and README.md is the COMMITTED text,
      // not the dirty one — proving the modified source was skipped too.
      expect(existsSync(join(worktreePath, SPACED_UNTRACKED))).toBe(false);
      expect(readFileSync(join(worktreePath, "README.md"), "utf-8")).toBe("# Test Repository\n");
    } finally {
      runner.dispose();
    }
  });

  test("untracked and modified stay off by default", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    const vibePath = getVibePath();

    writeFileSync(join(repoPath, SPACED_UNTRACKED), "scratch\n");
    writeFileSync(join(repoPath, "README.md"), "# Modified\n");

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner.spawn(["start", "feat/default-off"]);
      await runner.waitForExit();
      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const worktreePath = worktreePathFor(repoPath, "feat/default-off");
      await assertDirectoryExists(worktreePath);
      expect(existsSync(join(worktreePath, SPACED_UNTRACKED))).toBe(false);
      expect(readFileSync(join(worktreePath, "README.md"), "utf-8")).toBe("# Test Repository\n");
    } finally {
      runner.dispose();
    }
  });

  test("--no-hooks and --no-copy can be combined", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
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
    const trustRunner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
      const trustOutput = trustRunner.getOutput();
      assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
    } finally {
      trustRunner.dispose();
    }

    // Verify trust was successful before proceeding
    const verifyRunner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await verifyRunner.spawn(["verify"]);
      await verifyRunner.waitForExit();
      const verifyOutput = verifyRunner.getOutput();
      assertExitCode(verifyRunner.getExitCode(), 0, verifyOutput);
    } finally {
      verifyRunner.dispose();
    }

    // Wait for trust configuration to be synced before proceeding
    // Uses polling instead of fixed delay for reliability across CI environments
    await waitForCondition(() => existsSync(join(repoPath, ".vibe.toml")), {
      timeout: 5000,
      interval: 100,
    });

    // Run vibe start with both --no-hooks and --no-copy
    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner.spawn(["start", "feat/test-combined", "--no-hooks", "--no-copy"]);
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

  test("[copy] symlink shares a directory instead of copying it", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // A cache directory to SHARE and a dependency directory to COPY, both
    // untracked so their presence in the worktree proves vibe put them there.
    mkdirSync(join(repoPath, ".turbo"), { recursive: true });
    writeFileSync(join(repoPath, ".turbo/cache.bin"), "shared-cache\n");
    mkdirSync(join(repoPath, "node_modules"), { recursive: true });
    writeFileSync(join(repoPath, "node_modules/dep.txt"), "copied-dep\n");
    writeFileSync(join(repoPath, ".gitignore"), ".turbo\nnode_modules\n");
    writeFileSync(
      join(repoPath, ".vibe.toml"),
      `
[copy]
dirs = ["node_modules"]
symlink = [".turbo"]
`,
    );
    execFileSync("git", ["add", ".vibe.toml", ".gitignore"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add .vibe.toml with a symlink entry"], {
      cwd: repoPath,
      stdio: "pipe",
    });

    await trustConfig(vibePath, repoPath, homePath);

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner.spawn(["start", "feat/test-symlink"]);
      await runner.waitForExit();
      assertExitCode(runner.getExitCode(), 0, runner.getOutput());

      const parentDir = dirname(repoPath);
      const repoName = basename(repoPath);
      const worktreePath = `${parentDir}/${repoName}-feat-test-symlink`;
      await assertDirectoryExists(worktreePath);

      // The shared entry is a symlink pointing back into the origin worktree.
      const shared = join(worktreePath, ".turbo");
      expect(lstatSync(shared).isSymbolicLink()).toBe(true);
      expect(realpathSync(shared)).toBe(realpathSync(join(repoPath, ".turbo")));
      // Reading through it sees the origin's content — that is the sharing.
      expect(readFileSync(join(shared, "cache.bin"), "utf-8")).toBe("shared-cache\n");
      // A write through the link is visible from the origin (shared state).
      writeFileSync(join(shared, "from-worktree.bin"), "written\n");
      expect(existsSync(join(repoPath, ".turbo/from-worktree.bin"))).toBe(true);

      // The plain `dirs` entry is still a real, independent copy.
      const copied = join(worktreePath, "node_modules");
      expect(lstatSync(copied).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(copied, "dep.txt"), "utf-8")).toBe("copied-dep\n");
    } finally {
      runner.dispose();
    }
  });

  test("[copy] symlink takes precedence over the same dirs entry", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    mkdirSync(join(repoPath, ".cache"), { recursive: true });
    writeFileSync(join(repoPath, ".cache/data.bin"), "origin\n");
    writeFileSync(join(repoPath, ".gitignore"), ".cache\n");
    // `.cache` is listed in BOTH dirs and symlink.
    writeFileSync(
      join(repoPath, ".vibe.toml"),
      `
[copy]
dirs = [".cache"]
symlink = [".cache"]
`,
    );
    execFileSync("git", ["add", ".vibe.toml", ".gitignore"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add overlapping copy config"], {
      cwd: repoPath,
      stdio: "pipe",
    });

    await trustConfig(vibePath, repoPath, homePath);

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner.spawn(["start", "feat/test-symlink-precedence"]);
      await runner.waitForExit();
      assertExitCode(runner.getExitCode(), 0, runner.getOutput());

      const parentDir = dirname(repoPath);
      const repoName = basename(repoPath);
      const worktreePath = `${parentDir}/${repoName}-feat-test-symlink-precedence`;

      // The symlink entry wins: `.cache` is a link, not a copied directory.
      const shared = join(worktreePath, ".cache");
      expect(lstatSync(shared).isSymbolicLink()).toBe(true);
      expect(realpathSync(shared)).toBe(realpathSync(join(repoPath, ".cache")));
    } finally {
      runner.dispose();
    }
  });

  test("[copy] symlink wins over a dirs GLOB that expands to it", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    mkdirSync(join(repoPath, "shared/.cache"), { recursive: true });
    writeFileSync(join(repoPath, "shared/.cache/data.bin"), "origin\n");
    mkdirSync(join(repoPath, "shared/.turbo"), { recursive: true });
    writeFileSync(join(repoPath, "shared/.turbo/data.bin"), "copied\n");
    writeFileSync(join(repoPath, ".gitignore"), "shared\n");
    // The glob MATCHES `shared/.cache` without naming it, so the exclusion has
    // to survive glob expansion; otherwise the copy runs over (and through) the
    // link and writes into the origin worktree. Scoped under `shared/` so the
    // glob cannot wander into `.git`.
    writeFileSync(
      join(repoPath, ".vibe.toml"),
      `
[copy]
dirs = ["shared/.*"]
symlink = ["shared/.cache"]
`,
    );
    execFileSync("git", ["add", ".vibe.toml", ".gitignore"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add glob copy config overlapping a symlink"], {
      cwd: repoPath,
      stdio: "pipe",
    });

    await trustConfig(vibePath, repoPath, homePath);

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner.spawn(["start", "feat/test-symlink-glob"]);
      await runner.waitForExit();
      assertExitCode(runner.getExitCode(), 0, runner.getOutput());

      const parentDir = dirname(repoPath);
      const repoName = basename(repoPath);
      const worktreePath = `${parentDir}/${repoName}-feat-test-symlink-glob`;

      // `shared/.cache` stayed a link even though the glob matched it.
      const shared = join(worktreePath, "shared/.cache");
      expect(lstatSync(shared).isSymbolicLink()).toBe(true);
      expect(realpathSync(shared)).toBe(realpathSync(join(repoPath, "shared/.cache")));
      // The origin was not written through the link.
      expect(readFileSync(join(repoPath, "shared/.cache/data.bin"), "utf8")).toBe("origin\n");
      // The other glob match was still copied as a real directory.
      const copied = join(worktreePath, "shared/.turbo");
      expect(lstatSync(copied).isSymbolicLink()).toBe(false);
      expect(lstatSync(copied).isDirectory()).toBe(true);
    } finally {
      runner.dispose();
    }
  });

  test("a REJECTED [copy] symlink pattern still lets the dirs copy run", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    mkdirSync(join(repoPath, "packages/app"), { recursive: true });
    writeFileSync(join(repoPath, "packages/app/data.bin"), "copied\n");
    writeFileSync(join(repoPath, ".gitignore"), "packages\n");
    // A glob symlink entry is REFUSED, so no link is ever created. The `dirs`
    // copy of the ancestor it lexically overlaps must therefore still run —
    // suppressing it would leave the worktree without `packages` at all.
    writeFileSync(
      join(repoPath, ".vibe.toml"),
      `
[copy]
dirs = ["packages"]
symlink = ["packages/*"]
`,
    );
    execFileSync("git", ["add", ".vibe.toml", ".gitignore"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add a rejected symlink pattern next to a dirs copy"], {
      cwd: repoPath,
      stdio: "pipe",
    });

    await trustConfig(vibePath, repoPath, homePath);

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner.spawn(["start", "feat/test-symlink-rejected"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);
      assertOutputContains(output, "globs are not supported");

      const parentDir = dirname(repoPath);
      const repoName = basename(repoPath);
      const worktreePath = `${parentDir}/${repoName}-feat-test-symlink-rejected`;

      const copied = join(worktreePath, "packages");
      expect(lstatSync(copied).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(copied, "app/data.bin"), "utf8")).toBe("copied\n");
    } finally {
      runner.dispose();
    }
  });

  test("[copy] symlink with a missing target warns but still creates the worktree", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    writeFileSync(
      join(repoPath, ".vibe.toml"),
      `
[copy]
symlink = ["never-created"]
`,
    );
    execFileSync("git", ["add", ".vibe.toml"], { cwd: repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add symlink config with a missing target"], {
      cwd: repoPath,
      stdio: "pipe",
    });

    await trustConfig(vibePath, repoPath, homePath);

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner.spawn(["start", "feat/test-symlink-missing"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      // Non-fatal: the worktree is created and the run succeeds.
      assertExitCode(runner.getExitCode(), 0, output);
      assertOutputContains(output, "target does not exist");

      const parentDir = dirname(repoPath);
      const repoName = basename(repoPath);
      const worktreePath = `${parentDir}/${repoName}-feat-test-symlink-missing`;
      await assertDirectoryExists(worktreePath);
      expect(existsSync(join(worktreePath, "never-created"))).toBe(false);
    } finally {
      runner.dispose();
    }
  });

  test("runs .vibe.toml from one initialized submodule", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const fooSource = createSubmoduleSource(homePath, "foo", ".foo-submodule-hook-ran");
    addSubmodule(repoPath, homePath, fooSource, "libs/foo");
    writeFileSync(join(repoPath, "libs/foo/.env"), "FOO_FROM_ORIGIN=1\n");

    writeFileSync(join(repoPath, ".vibe.toml"), '[submodules]\nconfigs = ["libs/foo"]\n');
    git(["add", ".vibe.toml", ".gitmodules", "libs/foo"], repoPath, homePath);
    git(["commit", "-m", "Add one submodule config"], repoPath, homePath);

    await trustConfig(vibePath, repoPath, homePath);
    await trustConfig(vibePath, fooSource, homePath);

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner.spawn(["start", "feat/one-submodule"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const parentDir = dirname(repoPath);
      const repoName = basename(repoPath);
      const worktreePath = `${parentDir}/${repoName}-feat-one-submodule`;
      const submoduleWorktreePath = join(worktreePath, "libs/foo");

      await assertDirectoryExists(submoduleWorktreePath);
      expect(existsSync(join(submoduleWorktreePath, ".vibe.toml"))).toBe(true);
      expect(readFileSync(join(submoduleWorktreePath, ".env"), "utf-8")).toBe(
        "FOO_FROM_ORIGIN=1\n",
      );
      expect(existsSync(join(submoduleWorktreePath, ".foo-submodule-hook-ran"))).toBe(true);
    } finally {
      runner.dispose();
    }
  });

  test("runs .vibe.toml from multiple initialized submodules", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const fooSource = createSubmoduleSource(homePath, "foo", ".foo-submodule-hook-ran");
    const barSource = createSubmoduleSource(homePath, "bar", ".bar-submodule-hook-ran");
    addSubmodule(repoPath, homePath, fooSource, "libs/foo");
    addSubmodule(repoPath, homePath, barSource, "vendor/bar");
    writeFileSync(join(repoPath, "libs/foo/.env"), "FOO_FROM_ORIGIN=1\n");
    writeFileSync(join(repoPath, "vendor/bar/.env"), "BAR_FROM_ORIGIN=1\n");

    writeFileSync(
      join(repoPath, ".vibe.toml"),
      '[submodules]\nconfigs = ["libs/foo", "vendor/bar"]\n',
    );
    git(["add", ".vibe.toml", ".gitmodules", "libs/foo", "vendor/bar"], repoPath, homePath);
    git(["commit", "-m", "Add multiple submodule configs"], repoPath, homePath);

    await trustConfig(vibePath, repoPath, homePath);
    await trustConfig(vibePath, fooSource, homePath);
    await trustConfig(vibePath, barSource, homePath);

    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await runner.spawn(["start", "feat/multiple-submodules"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const parentDir = dirname(repoPath);
      const repoName = basename(repoPath);
      const worktreePath = `${parentDir}/${repoName}-feat-multiple-submodules`;
      const fooWorktreePath = join(worktreePath, "libs/foo");
      const barWorktreePath = join(worktreePath, "vendor/bar");

      await assertDirectoryExists(fooWorktreePath);
      await assertDirectoryExists(barWorktreePath);
      expect(existsSync(join(fooWorktreePath, ".vibe.toml"))).toBe(true);
      expect(existsSync(join(barWorktreePath, ".vibe.toml"))).toBe(true);
      expect(readFileSync(join(fooWorktreePath, ".env"), "utf-8")).toBe(
        "FOO_FROM_ORIGIN=1\n",
      );
      expect(readFileSync(join(barWorktreePath, ".env"), "utf-8")).toBe(
        "BAR_FROM_ORIGIN=1\n",
      );
      expect(existsSync(join(fooWorktreePath, ".foo-submodule-hook-ran"))).toBe(true);
      expect(existsSync(join(barWorktreePath, ".bar-submodule-hook-ran"))).toBe(true);
    } finally {
      runner.dispose();
    }
  });

  test("worktree.path_script in .vibe.toml determines worktree path", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
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
    const trustRunner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
      const trustOutput = trustRunner.getOutput();
      assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
    } finally {
      trustRunner.dispose();
    }

    // Wait for trust configuration to be synced before proceeding
    await waitForCondition(() => existsSync(join(repoPath, ".vibe.toml")), {
      timeout: 5000,
      interval: 100,
    });

    // Run vibe start
    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
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
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
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
    const trustRunner = new VibeCommandRunner(vibePath, repoPath, homePath);
    try {
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
      const trustOutput = trustRunner.getOutput();
      assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
    } finally {
      trustRunner.dispose();
    }

    // Run vibe start
    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);
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
