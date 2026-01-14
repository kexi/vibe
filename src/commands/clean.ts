import {
  getMainWorktreePath,
  getRepoRoot,
  hasUncommittedChanges,
  isMainWorktree,
  runGitCommand,
} from "../utils/git.ts";
import { loadVibeConfig } from "../utils/config.ts";
import { type HookTrackerInfo, runHooks } from "../utils/hooks.ts";
import { confirm } from "../utils/prompt.ts";
import { ProgressTracker } from "../utils/progress.ts";

export async function cleanCommand(): Promise<void> {
  try {
    const isMain = await isMainWorktree();
    if (isMain) {
      console.error(
        "Error: Cannot clean main worktree. Use this command from a secondary worktree.",
      );
      Deno.exit(1);
    }

    const hasChanges = await hasUncommittedChanges();
    if (hasChanges) {
      const shouldContinue = await confirm(
        "Warning: This worktree has uncommitted changes. Do you want to continue? (Y/n)",
      );
      if (!shouldContinue) {
        console.error("Clean operation cancelled.");
        Deno.exit(0);
      }
    }

    const currentWorktreePath = await getRepoRoot();
    const mainPath = await getMainWorktreePath();

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
    await runGitCommand([
      "-C",
      mainPath,
      "worktree",
      "remove",
      currentWorktreePath,
    ]);

    // Run post_clean hooks from main worktree
    const postCleanHooks = config?.hooks?.post_clean;
    if (postCleanHooks !== undefined && postCleanHooks.length > 0) {
      await runHooks(postCleanHooks, mainPath, {
        worktreePath: currentWorktreePath,
        originPath: mainPath,
      });
    }

    console.error(`Worktree ${currentWorktreePath} has been removed.`);

    // Output cd command for shell wrapper to eval
    console.log(`cd '${mainPath}'`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    Deno.exit(1);
  }
}
