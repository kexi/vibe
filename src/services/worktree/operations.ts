/**
 * Worktree operations service
 *
 * Provides Git worktree create/remove operations.
 */

import { runGitCommand } from "../../utils/git.ts";
import { type AppContext, getGlobalContext } from "../../context/index.ts";

/**
 * Options for creating a worktree
 */
export interface CreateWorktreeOptions {
  /** The branch name for the worktree */
  branchName: string;
  /** The path where the worktree will be created */
  worktreePath: string;
  /** Whether the branch already exists (false = create new branch) */
  branchExists: boolean;
}

/**
 * Options for removing a worktree
 */
export interface RemoveWorktreeOptions {
  /** The path of the worktree to remove */
  worktreePath: string;
  /** Whether to force removal */
  force?: boolean;
}

/**
 * Create a new git worktree
 *
 * If the branch doesn't exist, it will be created with -b flag.
 */
export async function createWorktree(
  options: CreateWorktreeOptions,
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const { branchName, worktreePath, branchExists } = options;

  if (branchExists) {
    await runGitCommand(["worktree", "add", worktreePath, branchName], ctx);
  } else {
    await runGitCommand(["worktree", "add", "-b", branchName, worktreePath], ctx);
  }
}

/**
 * Remove a git worktree
 */
export async function removeWorktree(
  options: RemoveWorktreeOptions,
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const { worktreePath, force = false } = options;

  const args = ["worktree", "remove", worktreePath];
  if (force) {
    args.push("--force");
  }

  await runGitCommand(args, ctx);
}

/**
 * Get the git command that would be run to create a worktree
 * (for dry-run logging)
 */
export function getCreateWorktreeCommand(options: CreateWorktreeOptions): string {
  const { branchName, worktreePath, branchExists } = options;

  if (branchExists) {
    return `git worktree add '${worktreePath}' ${branchName}`;
  }
  return `git worktree add -b ${branchName} '${worktreePath}'`;
}
