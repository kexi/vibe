/**
 * Worktree operations service
 *
 * Provides Git worktree create/remove operations.
 */

import { runGitCommand } from "../../utils/git.ts";
import { escapeShellPath } from "../../utils/shell.ts";
import { validateWorktreePath } from "../../utils/worktree-path-validation.ts";
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
  /** Optional base reference for creating a new branch */
  baseRef?: string;
  /** Whether to set upstream tracking when using baseRef (default: false) */
  track?: boolean;
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
 * If the branch doesn't exist, it will be created with -b (optionally from a base ref).
 */
export async function createWorktree(
  options: CreateWorktreeOptions,
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const { branchName, branchExists, baseRef, track } = options;
  const worktreePath = validateWorktreePath(options.worktreePath);

  if (branchExists) {
    await runGitCommand(["worktree", "add", worktreePath, branchName], ctx);
  } else if (baseRef) {
    const trackFlag = track ? "--track" : "--no-track";
    await runGitCommand(
      ["worktree", "add", "-b", branchName, trackFlag, worktreePath, baseRef],
      ctx,
    );
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
  const { force = false } = options;
  const worktreePath = validateWorktreePath(options.worktreePath);

  const args = ["worktree", "remove"];
  if (force) {
    args.push("--force");
  }
  args.push(worktreePath);

  await runGitCommand(args, ctx);
}

/**
 * Get the git command that would be run to create a worktree
 * (for dry-run logging).
 *
 * The returned string is for display only and must not be eval'd by a shell.
 * Throws if `worktreePath` fails validation.
 */
export function getCreateWorktreeCommand(options: CreateWorktreeOptions): string {
  const { branchName, branchExists, baseRef, track } = options;
  const worktreePath = validateWorktreePath(options.worktreePath);
  const quotedPath = `'${escapeShellPath(worktreePath)}'`;

  if (branchExists) {
    return `git worktree add ${quotedPath} ${branchName}`;
  }
  if (baseRef) {
    const trackFlag = track ? "--track" : "--no-track";
    return `git worktree add -b ${branchName} ${trackFlag} ${quotedPath} ${baseRef}`;
  }
  return `git worktree add -b ${branchName} ${quotedPath}`;
}
