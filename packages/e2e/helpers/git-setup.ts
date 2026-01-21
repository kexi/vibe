import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Setup a test Git repository for E2E testing
 */
export async function setupTestGitRepo(): Promise<{
  repoPath: string;
  homePath: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "vibe-e2e-test-"));
  const homePath = mkdtempSync(join(tmpdir(), "vibe-e2e-home-"));

  // Initialize Git repository
  runCommand(["git", "init"], tempDir);
  runCommand(["git", "config", "user.email", "test@example.com"], tempDir);
  runCommand(["git", "config", "user.name", "Test User"], tempDir);

  // Create initial commit
  writeFileSync(join(tempDir, "README.md"), "# Test Repository\n");
  runCommand(["git", "add", "README.md"], tempDir);
  runCommand(["git", "commit", "-m", "Initial commit"], tempDir);

  // Ensure we're on main branch
  runCommand(["git", "branch", "-M", "main"], tempDir);

  const cleanup = async () => {
    // Remove all worktrees (except main)
    try {
      const worktrees = getWorktreeList(tempDir);
      for (const wt of worktrees.slice(1)) {
        runCommand(["git", "worktree", "remove", wt.path, "--force"], tempDir);
      }
    } catch {
      // Ignore errors during cleanup
    }

    // Remove temporary directories
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory is already removed
    }
    try {
      rmSync(homePath, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory is already removed
    }
  };

  return { repoPath: tempDir, homePath, cleanup };
}

/**
 * Run a command and throw an error if it fails
 * Uses execFileSync for better security (no shell injection)
 */
function runCommand(args: string[], cwd: string): void {
  try {
    const [cmd, ...cmdArgs] = args;
    execFileSync(cmd, cmdArgs, {
      cwd,
      stdio: "pipe",
    });
  } catch (error: any) {
    throw new Error(
      `Command failed: ${args.join(" ")}\n${error.stderr?.toString() || error.message}`,
    );
  }
}

/**
 * Get list of worktrees in the repository
 */
function getWorktreeList(
  repoPath: string,
): { path: string; branch: string }[] {
  try {
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath,
      encoding: "utf-8",
    });

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
  } catch {
    return [];
  }
}
