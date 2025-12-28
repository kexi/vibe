/**
 * Setup a test Git repository for E2E testing
 */
export async function setupTestGitRepo(): Promise<{
  repoPath: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await Deno.makeTempDir({ prefix: "vibe-e2e-test-" });

  // Initialize Git repository
  await runCommand(["git", "init"], tempDir);
  await runCommand(
    ["git", "config", "user.email", "test@example.com"],
    tempDir,
  );
  await runCommand(["git", "config", "user.name", "Test User"], tempDir);

  // Create initial commit
  await Deno.writeTextFile(`${tempDir}/README.md`, "# Test Repository\n");
  await runCommand(["git", "add", "README.md"], tempDir);
  await runCommand(["git", "commit", "-m", "Initial commit"], tempDir);

  // Ensure we're on main branch
  await runCommand(["git", "branch", "-M", "main"], tempDir);

  const cleanup = async () => {
    // Remove all worktrees (except main)
    try {
      const worktrees = await getWorktreeList(tempDir);
      for (const wt of worktrees.slice(1)) {
        await runCommand(
          ["git", "worktree", "remove", wt.path, "--force"],
          tempDir,
        );
      }
    } catch {
      // Ignore errors during cleanup
    }

    // Remove temporary directory
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Ignore errors if directory is already removed
    }
  };

  return { repoPath: tempDir, cleanup };
}

/**
 * Run a git command and throw an error if it fails
 */
async function runCommand(args: string[], cwd: string): Promise<void> {
  const cmd = new Deno.Command(args[0], {
    args: args.slice(1),
    cwd,
    stdout: "null",
    stderr: "null",
  });

  const { code } = await cmd.output();
  if (code !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}`);
  }
}

/**
 * Get list of worktrees in the repository
 */
async function getWorktreeList(
  repoPath: string,
): Promise<{ path: string; branch: string }[]> {
  const cmd = new Deno.Command("git", {
    args: ["worktree", "list", "--porcelain"],
    cwd: repoPath,
    stdout: "piped",
    stderr: "null",
  });

  const { code, stdout } = await cmd.output();
  if (code !== 0) {
    return [];
  }

  const output = new TextDecoder().decode(stdout);
  const worktrees: { path: string; branch: string }[] = [];
  const lines = output.split("\n");

  let currentPath = "";
  let currentBranch = "";

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      currentPath = line.substring("worktree ".length);
    } else if (line.startsWith("branch ")) {
      currentBranch = line.substring("branch ".length);
      if (currentPath) {
        worktrees.push({ path: currentPath, branch: currentBranch });
        currentPath = "";
        currentBranch = "";
      }
    }
  }

  return worktrees;
}
