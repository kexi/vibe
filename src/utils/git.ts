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
