/**
 * Node.js I/O implementation
 */

import { Buffer } from "node:buffer";
import type { RuntimeIO, StderrStream, StdinStream } from "../types.ts";

const stdinStream: StdinStream = {
  async read(buffer: Uint8Array): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const stdin = process.stdin;

      // Set raw mode if it's a TTY to read character by character
      const wasPaused = stdin.isPaused();

      if (wasPaused) {
        stdin.resume();
      }

      const onReadable = () => {
        const chunk = stdin.read(buffer.length);
        cleanup();

        if (chunk === null) {
          resolve(null);
        } else {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const len = Math.min(bytes.length, buffer.length);
          bytes.copy(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength), 0, 0, len);
          resolve(len);
        }
      };

      const onEnd = () => {
        cleanup();
        resolve(null);
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        stdin.removeListener("readable", onReadable);
        stdin.removeListener("end", onEnd);
        stdin.removeListener("error", onError);
        if (wasPaused) {
          stdin.pause();
        }
      };

      stdin.once("readable", onReadable);
      stdin.once("end", onEnd);
      stdin.once("error", onError);
    });
  },

  isTerminal(): boolean {
    return process.stdin.isTTY ?? false;
  },
};

const stderrStream: StderrStream = {
  writeSync(data: Uint8Array): number {
    const buffer = Buffer.from(data);
    process.stderr.write(buffer);
    return data.length;
  },

  async write(data: Uint8Array): Promise<number> {
    return new Promise((resolve, reject) => {
      const buffer = Buffer.from(data);
      process.stderr.write(buffer, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve(data.length);
        }
      });
    });
  },

  isTerminal(): boolean {
    return process.stderr.isTTY ?? false;
  },
};

export const nodeIO: RuntimeIO = {
  stdin: stdinStream,
  stderr: stderrStream,
};
