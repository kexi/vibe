/**
 * Deno process implementation
 *
 * NOTE: Environment variable behavior is harmonized with Node.js:
 * - When env is provided, it is merged with the current environment (Deno.env.toObject())
 * - This matches Node.js child_process defaults for consistent cross-runtime behavior
 * - If complete isolation is needed, the caller should handle env construction
 */

import type {
  ChildProcess,
  RunOptions,
  RunResult,
  RuntimeProcess,
  SpawnOptions,
} from "../types.ts";

type StdioOption = "inherit" | "null" | "piped";

function toDenoStdio(stdio: StdioOption | undefined): "inherit" | "null" | "piped" {
  return stdio ?? "inherit";
}

/**
 * Merge provided env with current environment.
 * This ensures consistent behavior with Node.js where env is merged, not replaced.
 */
function mergeEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) {
    return undefined;
  }
  return { ...Deno.env.toObject(), ...env };
}

export const denoProcess: RuntimeProcess = {
  async run(options: RunOptions): Promise<RunResult> {
    const command = new Deno.Command(options.cmd, {
      args: options.args,
      cwd: options.cwd,
      env: mergeEnv(options.env),
      stdin: toDenoStdio(options.stdin),
      stdout: toDenoStdio(options.stdout),
      stderr: toDenoStdio(options.stderr),
    });

    const result = await command.output();

    return {
      code: result.code,
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },

  spawn(options: SpawnOptions): ChildProcess {
    const command = new Deno.Command(options.cmd, {
      args: options.args,
      cwd: options.cwd,
      env: mergeEnv(options.env),
      stdin: toDenoStdio(options.stdin),
      stdout: toDenoStdio(options.stdout),
      stderr: toDenoStdio(options.stderr),
    });

    const child = command.spawn();

    // Deno.Command doesn't have a direct 'detached' option like Node.js.
    // Behavioral differences:
    // - Node.js detached: true creates a new process group, fully detaching
    //   the child from the parent's terminal and allowing it to continue
    //   running even if the parent's terminal is closed.
    // - Deno unref(): Allows the parent process to exit without waiting for
    //   the child, but does NOT create a new process group. The child may
    //   still be affected if the parent's terminal is closed.
    //
    // For vibe's use case (background trash cleanup), unref() is sufficient
    // since we only need the parent to exit quickly, not full terminal detachment.
    const isDetached = options.detached === true;
    if (isDetached) {
      child.unref();
    }

    return {
      unref(): void {
        child.unref();
      },

      async wait(): Promise<{ code: number; success: boolean }> {
        const status = await child.status;
        return {
          code: status.code,
          success: status.success,
        };
      },

      get pid(): number {
        return child.pid;
      },
    };
  },
};
