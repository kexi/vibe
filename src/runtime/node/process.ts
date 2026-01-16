/**
 * Node.js process implementation
 */

import { Buffer } from "node:buffer";
import { spawn, type SpawnOptions as NodeSpawnOptions } from "node:child_process";
import type {
  ChildProcess,
  RunOptions,
  RunResult,
  RuntimeProcess,
  SpawnOptions,
} from "../types.ts";

type StdioOption = "inherit" | "null" | "piped";

function toNodeStdio(stdio: StdioOption | undefined): "inherit" | "ignore" | "pipe" {
  switch (stdio) {
    case "null":
      return "ignore";
    case "piped":
      return "pipe";
    case "inherit":
    default:
      return "inherit";
  }
}

export const nodeProcess: RuntimeProcess = {
  async run(options: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const spawnOptions: NodeSpawnOptions = {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : undefined,
        stdio: [
          toNodeStdio(options.stdin),
          toNodeStdio(options.stdout),
          toNodeStdio(options.stderr),
        ],
      };

      const child = spawn(options.cmd, options.args ?? [], spawnOptions);

      if (child.stdout) {
        child.stdout.on("data", (chunk: Buffer) => {
          stdoutChunks.push(chunk);
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          stderrChunks.push(chunk);
        });
      }

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        const exitCode = code ?? 1;
        resolve({
          code: exitCode,
          success: exitCode === 0,
          stdout: new Uint8Array(Buffer.concat(stdoutChunks)),
          stderr: new Uint8Array(Buffer.concat(stderrChunks)),
        });
      });
    });
  },

  spawn(options: SpawnOptions): ChildProcess {
    const spawnOptions: NodeSpawnOptions = {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
      stdio: [
        toNodeStdio(options.stdin),
        toNodeStdio(options.stdout),
        toNodeStdio(options.stderr),
      ],
      detached: true,
    };

    const child = spawn(options.cmd, options.args ?? [], spawnOptions);

    return {
      unref(): void {
        child.unref();
      },

      async wait(): Promise<{ code: number; success: boolean }> {
        return new Promise((resolve) => {
          child.on("close", (code) => {
            const exitCode = code ?? 1;
            resolve({
              code: exitCode,
              success: exitCode === 0,
            });
          });
        });
      },

      get pid(): number {
        return child.pid ?? -1;
      },
    };
  },
};
