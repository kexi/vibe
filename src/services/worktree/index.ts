/**
 * Worktree service module
 *
 * Provides high-level operations for git worktree management.
 */

export {
  type BranchValidationResult,
  checkWorktreeConflict,
  validateBranchForWorktree,
  type WorktreeConflictResult,
} from "./validator.ts";

export {
  createWorktree,
  type CreateWorktreeOptions,
  getCreateWorktreeCommand,
  removeWorktree,
  type RemoveWorktreeOptions,
} from "./operations.ts";
