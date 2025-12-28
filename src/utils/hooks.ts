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
      stdout: "piped",
      stderr: "inherit",
    });
    const result = await proc.output();

    // Write hook stdout to stderr so it doesn't interfere with shell wrapper eval
    if (result.stdout.length > 0) {
      try {
        await Deno.stderr.write(result.stdout);
      } catch (error) {
        // Fallback: if stderr write fails, at least don't crash the hook execution
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Warning: Failed to write hook output to stderr: ${errorMessage}`);
      }
    }

    if (!result.success) {
      throw new Error(`Hook failed with exit code ${result.code}: ${cmd}`);
    }
  }
}
