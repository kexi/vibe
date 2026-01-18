import { bold } from "@std/fmt/colors";
import { dirname, join } from "@std/path";
import {
  getCurrentBranch,
  getDefaultBranch,
  getMainWorktreePath,
  getRepoRoot,
  getWorktreeByPath,
  hasUncommittedChanges,
  isMainWorktree,
  runGitCommand,
} from "../utils/git.ts";
import { loadVibeConfig } from "../utils/config.ts";
import { type HookTrackerInfo, runHooks } from "../utils/hooks.ts";
import { confirm } from "../utils/prompt.ts";
import { ProgressTracker } from "../utils/progress.ts";
import { log, type OutputOptions, verboseLog } from "../utils/output.ts";
import { loadUserSettings } from "../utils/settings.ts";
import {
  cleanupStaleTrash,
  fastRemoveDirectory,
  isFastRemoveSupported,
} from "../utils/fast-remove.ts";
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
      const fastResult = await fastRemoveDirectory(worktreePath, ctx);

      if (fastResult.success) {
        // Create empty directory with .git file for git worktree remove
        await runtime.fs.mkdir(worktreePath);
        await runtime.fs.writeTextFile(gitFilePath, gitFileContent);

        // Run git worktree remove on empty directory (very fast)
        // Always use --force since we've already moved the files
        const removeArgs = ["-C", mainPath, "worktree", "remove", "--force"];
        removeArgs.push(worktreePath);
        verboseLog(`Running: git ${removeArgs.join(" ")}`, outputOpts);
        await runGitCommand(removeArgs, ctx);

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
    const isMain = await isMainWorktree(ctx);
    if (isMain) {
      // Main worktree: offer to checkout default branch instead of error
      let defaultBranch: string;
      try {
        defaultBranch = await getDefaultBranch(ctx);
      } catch {
        // gh is not installed or not logged in - skip checkout offer
        runtime.control.exit(0);
        return; // TypeScript requires explicit return after exit()
      }

      const currentBranch = await getCurrentBranch(ctx);
      const isAlreadyOnDefaultBranch = currentBranch === defaultBranch;
      if (isAlreadyOnDefaultBranch) {
        log(`You're already on the default branch (${bold(defaultBranch)}).`, outputOpts);
        runtime.control.exit(0);
      }

      const shouldCheckout = await confirm(
        `You're in the main worktree. Would you like to checkout ${bold(defaultBranch)}? (Y/n)`,
        ctx,
      );

      if (shouldCheckout) {
        await runGitCommand(["checkout", defaultBranch], ctx);
        log(`Switched to ${bold(defaultBranch)}`, outputOpts);
      }
      runtime.control.exit(0);
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
    const currentBranch = worktreeInfo?.branch;

    // Load configuration
    const config = await loadVibeConfig(currentWorktreePath, ctx);

    // Create progress tracker
    const tracker = new ProgressTracker({
      title: "Cleaning up worktree",
    }, ctx);

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
      tracker.finish();
    }

    // Change to main worktree before removing (so cwd remains valid after deletion)
    runtime.control.chdir(mainPath);

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

    log(`Worktree ${currentWorktreePath} has been removed.`, outputOpts);

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
        log(`Branch ${currentBranch} has been deleted.`, outputOpts);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Warning: Could not delete branch ${currentBranch}: ${errorMessage}`);
        console.error("You may need to delete it manually with: git branch -D " + currentBranch);
      }
    }

    // Output cd command for shell wrapper to eval
    console.log(`cd '${mainPath}'`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    runtime.control.exit(1);
  }
}
