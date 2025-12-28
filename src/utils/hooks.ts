export interface HookEnvironment {
  worktreePath: string;
  originPath: string;
}

export async function runHooks(
  commands: string[],
  cwd: string,
  env: HookEnvironment,
): Promise<void> {
  const hookEnv = {
    ...Deno.env.toObject(),
    VIBE_WORKTREE_PATH: env.worktreePath,
    VIBE_ORIGIN_PATH: env.originPath,
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
