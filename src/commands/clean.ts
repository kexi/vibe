import { getMainWorktreePath, getRepoRoot, isMainWorktree } from "../utils/git.ts";
import { loadVibeConfig } from "../utils/config.ts";
import { runHooks } from "../utils/hooks.ts";

export async function cleanCommand(): Promise<void> {
  try {
    const isMain = await isMainWorktree();
    if (isMain) {
      console.error(
        "Error: Cannot clean main worktree. Use this command from a secondary worktree.",
      );
      Deno.exit(1);
    }

    const currentWorktreePath = await getRepoRoot();
    const mainPath = await getMainWorktreePath();

    // Load configuration
    const config = await loadVibeConfig(currentWorktreePath);

    // Run pre_clean hooks
    const hasPreCleanHooks = config?.hooks?.pre_clean !== undefined;
    if (hasPreCleanHooks) {
      await runHooks(config!.hooks!.pre_clean!, currentWorktreePath, {
        worktreePath: currentWorktreePath,
        originPath: mainPath,
      });
    }

    // Build remove command
    let removeCommand = `cd '${mainPath}' && git worktree remove '${currentWorktreePath}'`;

    // Append post_clean hooks to remove command
    const hasPostCleanHooks = config?.hooks?.post_clean !== undefined;
    if (hasPostCleanHooks) {
      for (const cmd of config!.hooks!.post_clean!) {
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
