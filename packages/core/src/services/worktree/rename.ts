/**
 * Worktree rename service
 *
 * Provides git operations needed by `vibe rename`:
 * - moving a worktree directory (`git worktree move`)
 * - renaming a branch (`git branch -m`)
 * - detecting whether a branch is pushed (has a non-local upstream remote)
 */

import { runGitCommand } from "../../utils/git.ts";
import { type AppContext, getGlobalContext } from "../../context/index.ts";

/**
 * Result of upstream detection.
 * - "none"  → no upstream configured
 * - "local" → local-tracking branch (`branch.<name>.remote = "."`)
 * - { remote } → branch is tracking a remote (i.e. likely pushed)
 */
export type BranchUpstream = "none" | "local" | { remote: string };

/**
 * Move a worktree directory using `git worktree move`.
 * The worktree's metadata (`.git/worktrees/<name>`) is updated by git.
 */
export async function moveWorktree(
  oldPath: string,
  newPath: string,
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  await runGitCommand(["worktree", "move", oldPath, newPath], ctx);
}

/**
 * Rename a branch with `git branch -m`.
 */
export async function renameBranch(
  oldName: string,
  newName: string,
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  await runGitCommand(["branch", "-m", oldName, newName], ctx);
}

/**
 * Detect the upstream remote of a branch.
 * Reads `branch.<name>.remote` from git config; exit 1 (key missing) is treated as "none".
 */
export async function getBranchUpstream(
  branchName: string,
  ctx: AppContext = getGlobalContext(),
): Promise<BranchUpstream> {
  let value: string;
  try {
    value = await runGitCommand(["config", "--get", `branch.${branchName}.remote`], ctx);
  } catch {
    return "none";
  }

  const trimmed = value.trim();
  if (trimmed === "") return "none";
  if (trimmed === ".") return "local";
  return { remote: trimmed };
}

/** Dry-run-friendly textual form of the move command. */
export function getMoveWorktreeCommand(oldPath: string, newPath: string): string {
  return `git worktree move '${oldPath}' '${newPath}'`;
}

/** Dry-run-friendly textual form of the branch rename command. */
export function getRenameBranchCommand(oldName: string, newName: string): string {
  return `git branch -m ${oldName} ${newName}`;
}
