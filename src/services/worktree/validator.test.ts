import { assertEquals } from "@std/assert";
import { createMockContext } from "../../context/testing.ts";
import { checkWorktreeConflict, validateBranchForWorktree } from "./validator.ts";
import type { RunResult } from "../../runtime/types.ts";

/**
 * Create a mock for git commands used in validator functions
 */
function createValidatorGitMock(overrides: {
  worktreeList?: Array<{ path: string; branch: string }>;
  branchExists?: boolean;
} = {}) {
  const { worktreeList = [], branchExists = false } = overrides;

  return (opts: { args?: string[] }) => {
    const args = opts.args as string[];

    // git worktree list --porcelain
    if (args.includes("worktree") && args.includes("list")) {
      let output = "";
      for (const wt of worktreeList) {
        output += `worktree ${wt.path}\nHEAD abc123\nbranch refs/heads/${wt.branch}\n\n`;
      }
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: new TextEncoder().encode(output),
        stderr: new Uint8Array(),
      } as RunResult);
    }

    // git show-ref --verify (check if branch exists)
    if (args.includes("show-ref") && args.includes("--verify")) {
      return Promise.resolve({
        code: branchExists ? 0 : 1,
        success: branchExists,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      } as RunResult);
    }

    // Default response
    return Promise.resolve({
      code: 0,
      success: true,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    } as RunResult);
  };
}

// =============================================================================
// validateBranchForWorktree tests
// =============================================================================

Deno.test("validateBranchForWorktree returns invalid when branch is in use by worktree", async () => {
  const ctx = createMockContext({
    process: {
      run: createValidatorGitMock({
        worktreeList: [
          { path: "/test/repo", branch: "main" },
          { path: "/test/worktrees/feature-branch", branch: "feature-branch" },
        ],
        branchExists: true,
      }),
    },
  });

  const result = await validateBranchForWorktree("feature-branch", ctx);

  assertEquals(result.isValid, false);
  assertEquals(result.branchExists, true);
  assertEquals(result.existingWorktreePath, "/test/worktrees/feature-branch");
});

Deno.test("validateBranchForWorktree returns valid when branch exists but not in worktree", async () => {
  const ctx = createMockContext({
    process: {
      run: createValidatorGitMock({
        worktreeList: [
          { path: "/test/repo", branch: "main" },
        ],
        branchExists: true,
      }),
    },
  });

  const result = await validateBranchForWorktree("existing-branch", ctx);

  assertEquals(result.isValid, true);
  assertEquals(result.branchExists, true);
  assertEquals(result.existingWorktreePath, null);
});

Deno.test("validateBranchForWorktree returns valid with branchExists=false for new branch", async () => {
  const ctx = createMockContext({
    process: {
      run: createValidatorGitMock({
        worktreeList: [
          { path: "/test/repo", branch: "main" },
        ],
        branchExists: false,
      }),
    },
  });

  const result = await validateBranchForWorktree("new-branch", ctx);

  assertEquals(result.isValid, true);
  assertEquals(result.branchExists, false);
  assertEquals(result.existingWorktreePath, null);
});

// =============================================================================
// checkWorktreeConflict tests
// =============================================================================

Deno.test("checkWorktreeConflict returns no conflict when path has no worktree", async () => {
  const ctx = createMockContext({
    process: {
      run: createValidatorGitMock({
        worktreeList: [
          { path: "/test/repo", branch: "main" },
        ],
      }),
    },
  });

  const result = await checkWorktreeConflict("/test/worktrees/new-path", "feature-branch", ctx);

  assertEquals(result.hasConflict, false);
  assertEquals(result.conflictType, "none");
  assertEquals(result.existingBranch, null);
});

Deno.test("checkWorktreeConflict returns same-branch when path has worktree with same branch", async () => {
  const ctx = createMockContext({
    process: {
      run: createValidatorGitMock({
        worktreeList: [
          { path: "/test/repo", branch: "main" },
          { path: "/test/worktrees/feature-branch", branch: "feature-branch" },
        ],
      }),
    },
  });

  const result = await checkWorktreeConflict(
    "/test/worktrees/feature-branch",
    "feature-branch",
    ctx,
  );

  assertEquals(result.hasConflict, false);
  assertEquals(result.conflictType, "same-branch");
  assertEquals(result.existingBranch, "feature-branch");
});

Deno.test("checkWorktreeConflict returns conflict when path has worktree with different branch", async () => {
  const ctx = createMockContext({
    process: {
      run: createValidatorGitMock({
        worktreeList: [
          { path: "/test/repo", branch: "main" },
          { path: "/test/worktrees/existing", branch: "other-branch" },
        ],
      }),
    },
  });

  const result = await checkWorktreeConflict(
    "/test/worktrees/existing",
    "new-branch",
    ctx,
  );

  assertEquals(result.hasConflict, true);
  assertEquals(result.conflictType, "different-branch");
  assertEquals(result.existingBranch, "other-branch");
});
