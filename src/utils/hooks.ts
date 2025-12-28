import type { ProgressTracker } from "./progress.ts";

export interface HookEnvironment {
  worktreePath: string;
  originPath: string;
}

export interface HookTrackerInfo {
  tracker: ProgressTracker;
  taskIds: string[];
}

/**
 * Execute hook commands sequentially with optional progress tracking.
 *
 * Output Behavior:
 * - When trackerInfo is NOT provided: Hook stdout is written to stderr to avoid
 *   interfering with shell wrapper eval (for commands like `cd` output).
 * - When trackerInfo IS provided: Hook stdout is suppressed to keep the progress
 *   display clean and avoid visual clutter.
 * - Failed hooks ALWAYS show stderr output regardless of trackerInfo, to aid debugging.
 *
 * @param commands - Array of shell commands to execute
 * @param cwd - Working directory for command execution
 * @param env - Hook environment variables (VIBE_WORKTREE_PATH, VIBE_ORIGIN_PATH)
 * @param trackerInfo - Optional progress tracker with task IDs for each command
 * @throws {Error} If any hook command fails (non-zero exit code)
 */
export async function runHooks(
  commands: string[],
  cwd: string,
  env: HookEnvironment,
  trackerInfo?: HookTrackerInfo,
): Promise<void> {
  const hookEnv = {
    ...Deno.env.toObject(),
    VIBE_WORKTREE_PATH: env.worktreePath,
    VIBE_ORIGIN_PATH: env.originPath,
  };

  // Detect platform and use appropriate shell
  const isWindows = Deno.build.os === "windows";
  const shell = isWindows ? "cmd" : "sh";

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const shellArgs = isWindows ? ["/c", cmd] : ["-c", cmd];

    // Update progress: start task
    if (trackerInfo) {
      trackerInfo.tracker.startTask(trackerInfo.taskIds[i]);
    }

    const proc = new Deno.Command(shell, {
      args: shellArgs,
      cwd,
      env: hookEnv,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await proc.output();

    // Write hook stdout to stderr so it doesn't interfere with shell wrapper eval
    // When tracker is enabled, suppress output to avoid interfering with progress display
    if (!trackerInfo && result.stdout.length > 0) {
      try {
        await Deno.stderr.write(result.stdout);
      } catch (error) {
        // Fallback: if stderr write fails, at least don't crash the hook execution
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(
          `Warning: Failed to write hook output to stderr: ${errorMessage}`,
        );
      }
    }

    if (!result.success) {
      // Update progress: fail task
      if (trackerInfo) {
        trackerInfo.tracker.failTask(
          trackerInfo.taskIds[i],
          `Exit code ${result.code}`,
        );
      }

      // Show stderr output for failed hooks to help with debugging
      if (result.stderr.length > 0) {
        try {
          await Deno.stderr.write(result.stderr);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(
            `Warning: Failed to write hook stderr: ${errorMessage}`,
          );
        }
      }

      throw new Error(`Hook failed with exit code ${result.code}: ${cmd}`);
    }

    // Update progress: complete task
    if (trackerInfo) {
      trackerInfo.tracker.completeTask(trackerInfo.taskIds[i]);
    }
  }
}
