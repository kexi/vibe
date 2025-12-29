import { relative, dirname, normalize, isAbsolute, SEPARATOR } from "@std/path";

export async function runGitCommand(args: string[]): Promise<string> {
  const command = new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    const errorMessage = new TextDecoder().decode(stderr);
    throw new Error(`git ${args.join(" ")} failed: ${errorMessage}`);
  }

  return new TextDecoder().decode(stdout).trim();
}

export async function getRepoRoot(): Promise<string> {
  return await runGitCommand(["rev-parse", "--show-toplevel"]);
}

export async function getRepoName(): Promise<string> {
  const root = await getRepoRoot();
  return root.split("/").pop() ?? "";
}

export async function isInsideWorktree(): Promise<boolean> {
  try {
    const result = await runGitCommand(["rev-parse", "--is-inside-work-tree"]);
    return result === "true";
  } catch {
    return false;
  }
}

export async function getWorktreeList(): Promise<
  { path: string; branch: string }[]
> {
  const output = await runGitCommand(["worktree", "list", "--porcelain"]);
  const lines = output.split("\n");
  const worktrees: { path: string; branch: string }[] = [];

  let currentPath = "";
  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      const branch = line.slice("branch refs/heads/".length);
      worktrees.push({ path: currentPath, branch });
    }
  }

  return worktrees;
}

export async function getMainWorktreePath(): Promise<string> {
  const worktrees = await getWorktreeList();
  const mainWorktree = worktrees[0];
  if (!mainWorktree) {
    throw new Error("Could not find main worktree");
  }
  return mainWorktree.path;
}

export async function isMainWorktree(): Promise<boolean> {
  const currentRoot = await getRepoRoot();
  const mainPath = await getMainWorktreePath();
  return currentRoot === mainPath;
}

export function sanitizeBranchName(branchName: string): string {
  return branchName.replace(/\//g, "-");
}

export async function branchExists(branchName: string): Promise<boolean> {
  try {
    await runGitCommand([
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branchName}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the worktree has any uncommitted changes
 * @returns true if there are changes, false otherwise
 */
export async function hasUncommittedChanges(): Promise<boolean> {
  const output = await runGitCommand(["status", "--porcelain"]);
  const hasChanges = output.trim().length > 0;
  return hasChanges;
}

/**
 * Find the worktree path that is using the specified branch
 * @param branchName Branch name
 * @returns Worktree path, or null if not found
 */
export async function findWorktreeByBranch(
  branchName: string,
): Promise<string | null> {
  const worktrees = await getWorktreeList();
  const found = worktrees.find((w) => w.branch === branchName);
  const isWorktreeFound = found !== undefined;
  if (isWorktreeFound) {
    return found.path;
  }
  return null;
}

/**
 * Normalize git remote URL for consistent comparison
 * Converts various URL formats to a canonical form: host/user/repo
 *
 * Examples:
 * - https://github.com/user/repo.git → github.com/user/repo
 * - git@github.com:user/repo.git → github.com/user/repo
 * - ssh://git@github.com/user/repo → github.com/user/repo
 *
 * @param url Raw git remote URL
 * @returns Normalized URL
 */
export function normalizeRemoteUrl(url: string): string {
  let normalized = url.trim();

  // Remove trailing .git suffix
  normalized = normalized.replace(/\.git$/, "");

  // Convert SSH format (git@host:path) to HTTPS-like (host/path)
  normalized = normalized.replace(/^git@([^:]+):/, "$1/");

  // Remove protocol (https://, http://, ssh://)
  normalized = normalized.replace(/^[a-z]+:\/\//, "");

  // Remove credentials if present (user:pass@host)
  normalized = normalized.replace(/^[^@]+@/, "");

  return normalized;
}

/**
 * Get the remote URL for the current repository
 * @returns Remote URL (normalized), or undefined if no remote exists
 */
export async function getRemoteUrl(): Promise<string | undefined> {
  try {
    const rawUrl = await runGitCommand(["config", "--get", "remote.origin.url"]);
    return normalizeRemoteUrl(rawUrl);
  } catch {
    // No remote configured
    return undefined;
  }
}

/**
 * Repository information extracted from a file path
 */
export interface RepoInfo {
  remoteUrl?: string;
  repoRoot: string;
  relativePath: string;
}

/**
 * Extract repository information from an absolute file path
 * This function resolves symlinks and determines the git repository containing the file
 *
 * @param absolutePath Absolute path to a file
 * @returns Repository information, or null if not in a git repository
 */
export async function getRepoInfoFromPath(
  absolutePath: string,
): Promise<RepoInfo | null> {
  try {
    // Resolve symlinks to real path for security
    const realPath = await Deno.realPath(absolutePath);
    const fileDir = dirname(realPath);

    // Use git -C to run commands in specific directory without changing CWD
    // This avoids race conditions when multiple calls run concurrently

    // Get repository root
    const repoRoot = await runGitCommand(["-C", fileDir, "rev-parse", "--show-toplevel"]);

    // Validate that repoRoot is absolute
    if (!isAbsolute(repoRoot)) {
      throw new Error("Repository root must be an absolute path");
    }

    // Normalize paths to prevent traversal attacks
    const normalizedRoot = normalize(repoRoot);
    const normalizedPath = normalize(realPath);

    // Verify realPath is within repoRoot by checking if it starts with repoRoot + separator
    if (!normalizedPath.startsWith(normalizedRoot + SEPARATOR) && normalizedPath !== normalizedRoot) {
      throw new Error("File is outside repository root");
    }

    // Calculate relative path from repo root
    const relativePath = relative(normalizedRoot, normalizedPath);

    // Additional safety check: ensure relative path doesn't contain ..
    if (relativePath.includes("..")) {
      throw new Error("Invalid relative path contains parent directory references");
    }

    // Get remote URL (may be undefined for local-only repos)
    let remoteUrl: string | undefined;
    try {
      const rawUrl = await runGitCommand(["-C", fileDir, "config", "--get", "remote.origin.url"]);
      remoteUrl = normalizeRemoteUrl(rawUrl);
    } catch {
      // No remote configured
      remoteUrl = undefined;
    }

    return {
      remoteUrl,
      repoRoot,
      relativePath,
    };
  } catch {
    // Not in a git repository or path doesn't exist
    return null;
  }
}
