import {
  getMainWorktreePath,
  getRepoRoot,
  hasUncommittedChanges,
  isMainWorktree,
} from "../utils/git.ts";
import { loadVibeConfig } from "../utils/config.ts";
import { runHooks } from "../utils/hooks.ts";
import { confirmPrompt } from "../utils/input.ts";

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
      const shouldContinue = await confirmPrompt(
        "Warning: This worktree has uncommitted changes. Do you want to continue?",
      );
      const userAborted = !shouldContinue;
      if (userAborted) {
        console.log("Clean operation cancelled.");
        Deno.exit(0);
      }
    }

    const currentWorktreePath = await getRepoRoot();
    const mainPath = await getMainWorktreePath();

    // Load configuration
    const config = await loadVibeConfig(currentWorktreePath);

    // Run pre_clean hooks
    const preCleanHooks = config?.hooks?.pre_clean;
    if (preCleanHooks !== undefined) {
      await runHooks(preCleanHooks, currentWorktreePath, {
        worktreePath: currentWorktreePath,
        originPath: mainPath,
      });
    }

    // Build remove command
    let removeCommand = `cd '${mainPath}' && git worktree remove '${currentWorktreePath}'`;

    // Append post_clean hooks to remove command
    const postCleanHooks = config?.hooks?.post_clean;
    if (postCleanHooks !== undefined) {
      for (const cmd of postCleanHooks) {
        removeCommand += ` && ${cmd}`;
      }
    }

    console.log(removeCommand);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    Deno.exit(1);
  }
}
