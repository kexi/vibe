import { dirname, join } from "@std/path";
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
import { log, type OutputOptions, verboseLog } from "../utils/output.ts";
import { loadUserSettings } from "../utils/settings.ts";
import {
  cleanupStaleTrash,
  fastRemoveDirectory,
  isFastRemoveSupported,
} from "../utils/fast-remove.ts";
import { runtime } from "../runtime/index.ts";

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
): Promise<void> {
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
      const fastResult = await fastRemoveDirectory(worktreePath);

      if (fastResult.success) {
        // Create empty directory with .git file for git worktree remove
        await runtime.fs.mkdir(worktreePath);
        await runtime.fs.writeTextFile(gitFilePath, gitFileContent);

        // Run git worktree remove on empty directory (very fast)
        // Always use --force since we've already moved the files
        const removeArgs = ["-C", mainPath, "worktree", "remove", "--force"];
        removeArgs.push(worktreePath);
        verboseLog(`Running: git ${removeArgs.join(" ")}`, outputOpts);
        await runGitCommand(removeArgs);

        // Clean up stale trash directories in the background
        const parentDir = dirname(worktreePath);
        cleanupStaleTrash(parentDir).catch(() => {
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
  await runGitCommand(removeArgs);
}

export async function cleanCommand(options: CleanOptions = {}): Promise<void> {
  const { verbose = false, quiet = false } = options;
  const outputOpts: OutputOptions = { verbose, quiet };

  try {
    const isMain = await isMainWorktree();
    if (isMain) {
      console.error(
        "Error: Cannot clean main worktree. Use this command from a secondary worktree.",
      );
      runtime.control.exit(1);
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
          runtime.control.exit(0);
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
    runtime.control.chdir(mainPath);

    // Load user settings to check fast_remove preference
    const settings = await loadUserSettings();
    const useFastRemove = settings.clean?.fast_remove ?? true; // Default: true

    // Remove worktree
    await removeWorktree(
      mainPath,
      currentWorktreePath,
      forceRemove,
      useFastRemove,
      outputOpts,
    );

    // Run post_clean hooks from main worktree
    const postCleanHooks = config?.hooks?.post_clean;
    if (postCleanHooks !== undefined && postCleanHooks.length > 0) {
      await runHooks(postCleanHooks, mainPath, {
        worktreePath: currentWorktreePath,
        originPath: mainPath,
      });
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
        await runGitCommand(["-C", mainPath, "branch", "-d", currentBranch]);
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
