/**
 * Deno process implementation
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

export const denoProcess: RuntimeProcess = {
  async run(options: RunOptions): Promise<RunResult> {
    const command = new Deno.Command(options.cmd, {
      args: options.args,
      cwd: options.cwd,
      env: options.env,
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
      env: options.env,
      stdin: toDenoStdio(options.stdin),
      stdout: toDenoStdio(options.stdout),
      stderr: toDenoStdio(options.stderr),
    });

    const child = command.spawn();

    // Deno.Command doesn't have a direct 'detached' option like Node.js.
    // However, unref() provides similar behavior by allowing the parent
    // process to exit without waiting for the child.
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
