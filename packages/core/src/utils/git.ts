import { basename, dirname, isAbsolute, normalize, relative, SEPARATOR } from "@std/path";
import { type AppContext, getGlobalContext } from "../context/index.ts";

export async function runGitCommand(
  args: string[],
  ctx: AppContext = getGlobalContext(),
): Promise<string> {
  const result = await ctx.runtime.process.run({
    cmd: "git",
    args,
    stdout: "piped",
    stderr: "piped",
  });

  if (!result.success) {
    const errorMessage = new TextDecoder().decode(result.stderr);
    throw new Error(`git ${args.join(" ")} failed: ${errorMessage}`);
  }

  return new TextDecoder().decode(result.stdout).trim();
}

export async function getRepoRoot(
  ctx: AppContext = getGlobalContext(),
): Promise<string> {
  return await runGitCommand(["rev-parse", "--show-toplevel"], ctx);
}

export async function getRepoName(
  ctx: AppContext = getGlobalContext(),
): Promise<string> {
  const root = await getRepoRoot(ctx);
  return basename(root);
}

export async function isInsideWorktree(
  ctx: AppContext = getGlobalContext(),
): Promise<boolean> {
  try {
    const result = await runGitCommand(["rev-parse", "--is-inside-work-tree"], ctx);
    return result === "true";
  } catch {
    return false;
  }
}

export async function getWorktreeList(
  ctx: AppContext = getGlobalContext(),
): Promise<
  { path: string; branch: string }[]
> {
  const output = await runGitCommand(["worktree", "list", "--porcelain"], ctx);
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

export async function getWorktreeByPath(
  path: string,
  ctx: AppContext = getGlobalContext(),
): Promise<{ path: string; branch: string } | null> {
  const worktrees = await getWorktreeList(ctx);
  const normalizedPath = normalize(path);
  return worktrees.find((w) => normalize(w.path) === normalizedPath) ?? null;
}

export async function getMainWorktreePath(
  ctx: AppContext = getGlobalContext(),
): Promise<string> {
  const worktrees = await getWorktreeList(ctx);
  const mainWorktree = worktrees[0];
  if (!mainWorktree) {
    throw new Error("Could not find main worktree");
  }
  return mainWorktree.path;
}

export async function isMainWorktree(
  ctx: AppContext = getGlobalContext(),
): Promise<boolean> {
  const currentRoot = await getRepoRoot(ctx);
  const mainPath = await getMainWorktreePath(ctx);
  return currentRoot === mainPath;
}

export function sanitizeBranchName(branchName: string): string {
  return branchName.replace(/\//g, "-");
}

export async function branchExists(
  branchName: string,
  ctx: AppContext = getGlobalContext(),
): Promise<boolean> {
  try {
    await runGitCommand([
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branchName}`,
    ], ctx);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the worktree has any uncommitted changes
 * @returns true if there are changes, false otherwise
 */
export async function hasUncommittedChanges(
  ctx: AppContext = getGlobalContext(),
): Promise<boolean> {
  const output = await runGitCommand(["status", "--porcelain"], ctx);
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
  ctx: AppContext = getGlobalContext(),
): Promise<string | null> {
  const worktrees = await getWorktreeList(ctx);
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
export async function getRemoteUrl(
  ctx: AppContext = getGlobalContext(),
): Promise<string | undefined> {
  try {
    const rawUrl = await runGitCommand(["config", "--get", "remote.origin.url"], ctx);
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
 * Get the current branch name
 * @returns Current branch name
 * @throws Error if not on a branch (detached HEAD state)
 */
export async function getCurrentBranch(
  ctx: AppContext = getGlobalContext(),
): Promise<string> {
  const branch = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], ctx);
  if (branch === "HEAD") {
    throw new Error("Not on a branch (detached HEAD state)");
  }
  return branch;
}

/**
 * Get the default branch for the repository using GitHub CLI
 *
 * @returns Default branch name
 * @throws Error if gh command fails or is not available
 */
export async function getDefaultBranch(
  ctx: AppContext = getGlobalContext(),
): Promise<string> {
  const result = await ctx.runtime.process.run({
    cmd: "gh",
    args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
    stdout: "piped",
    stderr: "piped",
  });

  if (!result.success) {
    const errorMessage = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`Failed to get default branch: ${errorMessage}`);
  }

  const branch = new TextDecoder().decode(result.stdout).trim();
  if (!branch) {
    throw new Error("Could not determine default branch from GitHub");
  }

  // Defensive validation: ensure branch name doesn't contain newline characters
  const hasInvalidCharacters = branch.includes("\n") || branch.includes("\r");
  if (hasInvalidCharacters) {
    throw new Error("Invalid branch name format: contains newline characters");
  }

  return branch;
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
  ctx: AppContext = getGlobalContext(),
): Promise<RepoInfo | null> {
  try {
    // Resolve symlinks to real path for security
    const realPath = await ctx.runtime.fs.realPath(absolutePath);
    const fileDir = dirname(realPath);

    // Use git -C to run commands in specific directory without changing CWD
    // This avoids race conditions when multiple calls run concurrently

    // Get repository root
    const repoRoot = await runGitCommand(["-C", fileDir, "rev-parse", "--show-toplevel"], ctx);

    // Validate that repoRoot is absolute
    if (!isAbsolute(repoRoot)) {
      throw new Error("Repository root must be an absolute path");
    }

    // Normalize paths to prevent traversal attacks
    const normalizedRoot = normalize(repoRoot);
    const normalizedPath = normalize(realPath);

    // Verify realPath is within repoRoot by checking if it starts with repoRoot + separator
    if (
      !normalizedPath.startsWith(normalizedRoot + SEPARATOR) && normalizedPath !== normalizedRoot
    ) {
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
      const rawUrl = await runGitCommand(
        ["-C", fileDir, "config", "--get", "remote.origin.url"],
        ctx,
      );
      remoteUrl = normalizeRemoteUrl(rawUrl);
    } catch {
      // No remote configured
      remoteUrl = undefined;
    }

    return {
      remoteUrl,
      repoRoot: normalizedRoot,
      relativePath,
    };
  } catch {
    // Not in a git repository or path doesn't exist
    return null;
  }
}
