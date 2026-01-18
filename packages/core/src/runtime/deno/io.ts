/**
 * Deno I/O implementation
 */

import type { RuntimeIO, StderrStream, StdinStream } from "../types.ts";

const stdinStream: StdinStream = {
  read(buffer: Uint8Array): Promise<number | null> {
    return Deno.stdin.read(buffer);
  },

  isTerminal(): boolean {
    return Deno.stdin.isTerminal?.() ?? false;
  },
};

const stderrStream: StderrStream = {
  writeSync(data: Uint8Array): number {
    return Deno.stderr.writeSync(data);
  },

  write(data: Uint8Array): Promise<number> {
    return Deno.stderr.write(data);
  },

  isTerminal(): boolean {
    return Deno.stderr.isTerminal?.() ?? false;
  },
};

export const denoIO: RuntimeIO = {
  stdin: stdinStream,
  stderr: stderrStream,
};
