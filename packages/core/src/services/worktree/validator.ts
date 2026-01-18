/**
 * Worktree validation service
 *
 * Provides validation for branch and worktree operations.
 */

import { branchExists, findWorktreeByBranch, getWorktreeByPath } from "../../utils/git.ts";
import { type AppContext, getGlobalContext } from "../../context/index.ts";

/**
 * Result of branch validation for worktree creation
 */
export interface BranchValidationResult {
  /** Whether the branch is valid for worktree creation */
  isValid: boolean;
  /** Whether the branch already exists in git */
  branchExists: boolean;
  /** If branch is in use, the path of the existing worktree */
  existingWorktreePath: string | null;
}

/**
 * Result of worktree conflict check
 */
export interface WorktreeConflictResult {
  /** Whether there's a conflict at the target path */
  hasConflict: boolean;
  /** Type of conflict */
  conflictType: "none" | "same-branch" | "different-branch";
  /** The branch currently at the path (if any) */
  existingBranch: string | null;
}

/**
 * Validate a branch name for worktree creation
 *
 * Checks if:
 * - The branch is already in use by another worktree
 * - The branch exists in git
 */
export async function validateBranchForWorktree(
  branchName: string,
  ctx: AppContext = getGlobalContext(),
): Promise<BranchValidationResult> {
  const existingWorktreePath = await findWorktreeByBranch(branchName, ctx);
  const isBranchUsedInWorktree = existingWorktreePath !== null;

  if (isBranchUsedInWorktree) {
    return {
      isValid: false,
      branchExists: true,
      existingWorktreePath,
    };
  }

  const exists = await branchExists(branchName, ctx);

  return {
    isValid: true,
    branchExists: exists,
    existingWorktreePath: null,
  };
}

/**
 * Check for conflicts at the target worktree path
 *
 * Returns information about any existing worktree at the path.
 */
export async function checkWorktreeConflict(
  targetPath: string,
  branchName: string,
  ctx: AppContext = getGlobalContext(),
): Promise<WorktreeConflictResult> {
  const existingWorktree = await getWorktreeByPath(targetPath, ctx);

  if (existingWorktree === null) {
    return {
      hasConflict: false,
      conflictType: "none",
      existingBranch: null,
    };
  }

  const isSameBranch = existingWorktree.branch === branchName;
  if (isSameBranch) {
    return {
      hasConflict: false,
      conflictType: "same-branch",
      existingBranch: existingWorktree.branch,
    };
  }

  return {
    hasConflict: true,
    conflictType: "different-branch",
    existingBranch: existingWorktree.branch,
  };
}
