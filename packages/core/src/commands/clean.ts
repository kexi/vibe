import { dirname, join } from "node:path";
import {
  detectBrokenWorktreeLink,
  getMainWorktreePath,
  getRepoRoot,
  getWorktreeByPath,
  hasUncommittedChanges,
  isMainWorktree,
  runGitCommand,
} from "../utils/git.ts";
import { WorktreeError } from "../errors/index.ts";
import { loadVibeConfig } from "../utils/config.ts";
import { type HookTrackerInfo, runHooks } from "../utils/hooks.ts";
import { confirm } from "../utils/prompt.ts";
import { ProgressTracker } from "../utils/progress.ts";
import { type OutputOptions, successLog, verboseLog } from "../utils/output.ts";
import { loadUserSettings } from "../utils/settings.ts";
import {
  cleanupStaleTrash,
  fastRemoveDirectory,
  isFastRemoveSupported,
} from "../utils/fast-remove.ts";
import { escapeShellPath } from "../utils/shell.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";

interface CleanOptions extends OutputOptions {
  force?: boolean;
  deleteBranch?: boolean;
  keepBranch?: boolean;
}

/**
 * Remove worktree using fast remove (mv + async delete) or traditional git worktree remove
 */
async function removeWorktree(
  mainPath: string,
  worktreePath: string,
  forceRemove: boolean,
  useFastRemove: boolean,
  outputOpts: OutputOptions,
  ctx: AppContext,
): Promise<void> {
  const { runtime } = ctx;
  const shouldUseFastRemove = useFastRemove && isFastRemoveSupported();

  if (shouldUseFastRemove) {
    verboseLog("Using fast remove (mv + async delete)", outputOpts);

    // Read .git file content before moving (needed for git worktree remove)
    const gitFilePath = join(worktreePath, ".git");
    let gitFileContent: string | null = null;
    try {
      gitFileContent = await runtime.fs.readTextFile(gitFilePath);
    } catch {
      // .git file might not exist or be unreadable, will fall back to traditional method
    }

    if (gitFileContent) {
      const fastResult = await fastRemoveDirectory(worktreePath, ctx, outputOpts);

      if (fastResult.success) {
        // Create empty directory with .git file for git worktree remove
        try {
          await runtime.fs.mkdir(worktreePath);
        } catch (mkdirError) {
          // AlreadyExists: another process created it first -> continue
          // NotFound: parent directory doesn't exist -> rethrow
          if (!runtime.errors.isAlreadyExists(mkdirError)) {
            throw mkdirError;
          }
        }

        try {
          await runtime.fs.writeTextFile(gitFilePath, gitFileContent);
        } catch (writeError) {
          // NotFound: directory was removed (another process finished) -> success
          if (runtime.errors.isNotFound(writeError)) {
            verboseLog("Worktree already removed by another process", outputOpts);
            return;
          }
          throw writeError;
        }

        // Run git worktree remove on empty directory (very fast)
        // Always use --force since we've already moved the files
        const removeArgs = ["-C", mainPath, "worktree", "remove", "--force"];
        removeArgs.push(worktreePath);
        verboseLog(`Running: git ${removeArgs.join(" ")}`, outputOpts);

        try {
          await runGitCommand(removeArgs, ctx);
        } catch (gitError) {
          // Handle cases where worktree was already removed by another process
          const errorMsg = gitError instanceof Error ? gitError.message : String(gitError);
          const isAlreadyRemoved =
            errorMsg.includes("not a working tree") ||
            errorMsg.includes("does not exist") ||
            errorMsg.includes("is not a valid path");
          if (isAlreadyRemoved) {
            verboseLog("Worktree already removed from git", outputOpts);
            return;
          }
          throw gitError;
        }

        // Clean up stale trash directories in the background
        const parentDir = dirname(worktreePath);
        cleanupStaleTrash(parentDir, ctx).catch(() => {
          // Ignore errors - best effort cleanup
        });

        return;
      }

      // Fast remove failed, fall back to traditional method
      verboseLog(
        `Fast remove failed: ${fastResult.error?.message}, falling back to git worktree remove`,
        outputOpts,
      );
    }
  }

  // Traditional git worktree remove
  const removeArgs = ["-C", mainPath, "worktree", "remove"];
  if (forceRemove) {
    removeArgs.push("--force");
  }
  removeArgs.push(worktreePath);
  verboseLog(`Running: git ${removeArgs.join(" ")}`, outputOpts);
  await runGitCommand(removeArgs, ctx);
}

export async function cleanCommand(
  options: CleanOptions = {},
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const { runtime } = ctx;
  const { verbose = false, quiet = false } = options;
  const outputOpts: OutputOptions = { verbose, quiet };

  try {
    const worktreeLink = await detectBrokenWorktreeLink(ctx);
    const isBrokenWorktreeLink = worktreeLink.isBroken;
    if (isBrokenWorktreeLink) {
      throw new WorktreeError(
        "The main worktree appears to have been deleted.\n" +
          `Expected git directory: ${worktreeLink.gitDir}\n\n` +
          "To clean up manually:\n" +
          `  1. Remove this worktree directory: rm -rf '${runtime.control.cwd()}'\n` +
          "  2. If the main repository still exists elsewhere, run: git worktree prune\n\n" +
          "This worktree cannot be cleaned automatically because the git repository link is broken.",
        runtime.control.cwd(),
      );
    }

    const isMain = await isMainWorktree(ctx);
    if (isMain) {
      console.error(
        "Error: Cannot clean main worktree. Use this command from a secondary worktree.",
      );
      runtime.control.exit(1);
    }

    const hasChanges = await hasUncommittedChanges(ctx);
    let forceRemove = false;
    if (hasChanges) {
      if (options.force) {
        forceRemove = true;
      } else {
        const shouldContinue = await confirm(
          "Warning: This worktree has uncommitted changes. Do you want to continue? (Y/n)",
          ctx,
        );
        if (!shouldContinue) {
          console.error("Clean operation cancelled.");
          runtime.control.exit(0);
        }
        forceRemove = true;
      }
    }

    const currentWorktreePath = await getRepoRoot(ctx);
    const mainPath = await getMainWorktreePath(ctx);

    // Get current branch name before removing worktree
    const worktreeInfo = await getWorktreeByPath(currentWorktreePath, ctx);

    // Early check: if worktree is already removed (another process finished), exit gracefully
    if (worktreeInfo === null) {
      successLog("Worktree already removed.", outputOpts);
      console.log(`cd '${escapeShellPath(mainPath)}'`);

      return;
    }

    const currentBranch = worktreeInfo.branch;

    // Load configuration
    const config = await loadVibeConfig(currentWorktreePath, ctx);

    // Create progress tracker
    const tracker = new ProgressTracker(
      {
        title: "Cleaning up worktree",
      },
      ctx,
    );

    // Run pre_clean hooks
    const preCleanHooks = config?.hooks?.pre_clean;
    if (preCleanHooks !== undefined && preCleanHooks.length > 0) {
      // Start progress tracking
      tracker.start();

      // Add phase and tasks
      const phaseId = tracker.addPhase("Pre-clean hooks");
      const taskIds = preCleanHooks.map((hook) => tracker.addTask(phaseId, hook));
      const trackerInfo: HookTrackerInfo = { tracker, taskIds };

      await runHooks(
        preCleanHooks,
        currentWorktreePath,
        {
          worktreePath: currentWorktreePath,
          originPath: mainPath,
        },
        trackerInfo,
        ctx,
      );

      // Finish progress tracking
      await tracker.finish();
    }

    // Change to main worktree before removing (so cwd remains valid after deletion)
    try {
      runtime.control.chdir(mainPath);
    } catch {
      // mainPath doesn't exist - this is a fatal error
      console.error(`Error: Cannot change to main worktree: ${mainPath}`);
      runtime.control.exit(1);
    }

    // Load user settings to check fast_remove preference
    const settings = await loadUserSettings(ctx);
    const useFastRemove = settings.clean?.fast_remove ?? true; // Default: true

    // Remove worktree
    await removeWorktree(
      mainPath,
      currentWorktreePath,
      forceRemove,
      useFastRemove,
      outputOpts,
      ctx,
    );

    // Run post_clean hooks from main worktree
    const postCleanHooks = config?.hooks?.post_clean;
    if (postCleanHooks !== undefined && postCleanHooks.length > 0) {
      await runHooks(
        postCleanHooks,
        mainPath,
        {
          worktreePath: currentWorktreePath,
          originPath: mainPath,
        },
        undefined,
        ctx,
      );
    }

    successLog(`Worktree ${currentWorktreePath} has been removed.`, outputOpts);

    // Determine whether to delete branch
    // Priority: CLI option > config > default (false)
    let shouldDeleteBranch = false;
    if (options.deleteBranch) {
      shouldDeleteBranch = true;
    } else if (options.keepBranch) {
      shouldDeleteBranch = false;
    } else if (config?.clean?.delete_branch !== undefined) {
      shouldDeleteBranch = config.clean.delete_branch;
    }

    // Delete branch if requested
    if (shouldDeleteBranch && currentBranch) {
      try {
        await runGitCommand(["-C", mainPath, "branch", "-d", currentBranch], ctx);
        successLog(`Branch ${currentBranch} has been deleted.`, outputOpts);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Warning: Could not delete branch ${currentBranch}: ${errorMessage}`);
        console.error("You may need to delete it manually with: git branch -D " + currentBranch);
      }
    }

    // Output cd command for shell wrapper to eval
    console.log(`cd '${escapeShellPath(mainPath)}'`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    runtime.control.exit(1);
  }
}
