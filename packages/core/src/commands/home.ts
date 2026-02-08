import { getMainWorktreePath, isInsideWorktree, isMainWorktree } from "../utils/git.ts";
import { log, type OutputOptions, verboseLog } from "../utils/output.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";

type HomeOptions = OutputOptions;

export async function homeCommand(
  options: HomeOptions = {},
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const { runtime } = ctx;
  const { verbose = false, quiet = false } = options;
  const outputOpts: OutputOptions = { verbose, quiet };

  try {
    const insideWorktree = await isInsideWorktree(ctx);
    if (!insideWorktree) {
      console.error("Error: Not inside a git repository.");
      runtime.control.exit(1);
      return;
    }

    const isMain = await isMainWorktree(ctx);
    if (isMain) {
      log("Already in the main worktree.", outputOpts);
      return;
    }

    const mainPath = await getMainWorktreePath(ctx);
    verboseLog(`Main worktree path: ${mainPath}`, outputOpts);

    log(`Returning to main worktree: ${mainPath}`, outputOpts);
    console.log(`cd '${mainPath}'`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    runtime.control.exit(1);
  }
}
