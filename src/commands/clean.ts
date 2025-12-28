import { getMainWorktreePath, getRepoRoot, isMainWorktree } from "../utils/git.ts";
import { loadVibeConfig } from "../utils/config.ts";

async function runHooks(
  commands: string[],
  cwd: string,
  env: { currentWorktreePath: string; mainPath: string },
): Promise<void> {
  const hookEnv = {
    ...Deno.env.toObject(),
    VIBE_WORKTREE_PATH: env.currentWorktreePath,
    VIBE_ORIGIN_PATH: env.mainPath,
  };

  for (const cmd of commands) {
    const proc = new Deno.Command("sh", {
      args: ["-c", cmd],
      cwd,
      env: hookEnv,
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.output();
  }
}

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

    // 設定の読み込み
    const config = await loadVibeConfig(currentWorktreePath);

    // pre_cleanフックの実行
    const hasPreCleanHooks = config?.hooks?.pre_clean !== undefined;
    if (hasPreCleanHooks) {
      await runHooks(config!.hooks!.pre_clean!, currentWorktreePath, {
        currentWorktreePath,
        mainPath,
      });
    }

    // 削除コマンドの構築
    let removeCommand = `cd '${mainPath}' && git worktree remove '${currentWorktreePath}'`;

    // post_cleanフックを削除コマンドに追加
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
