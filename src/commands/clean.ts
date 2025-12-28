import {
  getMainWorktreePath,
  getRepoRoot,
  isMainWorktree,
} from "../utils/git.ts";

export async function cleanCommand(): Promise<void> {
  try {
    const isMain = await isMainWorktree();
    if (isMain) {
      console.error(
        "echo 'Error: Cannot clean main worktree. Use this command from a secondary worktree.'",
      );
      Deno.exit(1);
    }

    const currentWorktreePath = await getRepoRoot();
    const mainPath = await getMainWorktreePath();

    console.log(
      `cd '${mainPath}' && git worktree remove '${currentWorktreePath}'`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`echo 'Error: ${errorMessage.replace(/'/g, "'\\''")}'`);
    Deno.exit(1);
  }
}
