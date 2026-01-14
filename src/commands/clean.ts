import {
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

interface CleanOptions {
  force?: boolean;
  deleteBranch?: boolean;
  keepBranch?: boolean;
}

export async function cleanCommand(options: CleanOptions = {}): Promise<void> {
  try {
    const isMain = await isMainWorktree();
    if (isMain) {
      console.error(
        "Error: Cannot clean main worktree. Use this command from a secondary worktree.",
      );
      Deno.exit(1);
    }

    const hasChanges = await hasUncommittedChanges();
    let forceRemove = false;
    if (hasChanges) {
      if (options.force) {
        forceRemove = true;
      } else {
        const shouldContinue = await confirm(
          "Warning: This worktree has uncommitted changes. Do you want to continue? (Y/n)",
        );
        if (!shouldContinue) {
          console.error("Clean operation cancelled.");
          Deno.exit(0);
        }
        forceRemove = true;
      }
    }

    const currentWorktreePath = await getRepoRoot();
    const mainPath = await getMainWorktreePath();

    // Get current branch name before removing worktree
    const worktreeInfo = await getWorktreeByPath(currentWorktreePath);
    const currentBranch = worktreeInfo?.branch;

    // Load configuration
    const config = await loadVibeConfig(currentWorktreePath);

    // Create progress tracker
    const tracker = new ProgressTracker({
      title: "Cleaning up worktree",
    });

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
      );

      // Finish progress tracking
      tracker.finish();
    }

    // Change to main worktree before removing (so cwd remains valid after deletion)
    Deno.chdir(mainPath);

    // Remove worktree
    const removeArgs = ["-C", mainPath, "worktree", "remove"];
    if (forceRemove) {
      removeArgs.push("--force");
    }
    removeArgs.push(currentWorktreePath);
    await runGitCommand(removeArgs);

    // Run post_clean hooks from main worktree
    const postCleanHooks = config?.hooks?.post_clean;
    if (postCleanHooks !== undefined && postCleanHooks.length > 0) {
      await runHooks(postCleanHooks, mainPath, {
        worktreePath: currentWorktreePath,
        originPath: mainPath,
      });
    }

    console.error(`Worktree ${currentWorktreePath} has been removed.`);

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
        await runGitCommand(["-C", mainPath, "branch", "-d", currentBranch]);
        console.error(`Branch ${currentBranch} has been deleted.`);
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
    Deno.exit(1);
  }
}
