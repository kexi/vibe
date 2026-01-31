/**
 * Node.js I/O implementation
 */

import { Buffer } from "node:buffer";
import type { RuntimeIO, StderrStream, StdinStream } from "../types.ts";

const stdinStream: StdinStream = {
  async read(buffer: Uint8Array): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const stdin = process.stdin;

      // Try to read immediately first (for data already in buffer)
      const immediateChunk = stdin.read(buffer.length);
      if (immediateChunk !== null) {
        const bytes = Buffer.isBuffer(immediateChunk)
          ? immediateChunk
          : Buffer.from(immediateChunk);
        const len = Math.min(bytes.length, buffer.length);
        bytes.copy(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength), 0, 0, len);
        resolve(len);
        return;
      }

      // No data available immediately, wait for it
      const wasPaused = stdin.isPaused();
      if (wasPaused) {
        stdin.resume();
      }

      const onData = (chunk: Buffer | string) => {
        cleanup();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const len = Math.min(bytes.length, buffer.length);
        bytes.copy(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength), 0, 0, len);
        resolve(len);
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
        stdin.removeListener("data", onData);
        stdin.removeListener("end", onEnd);
        stdin.removeListener("error", onError);
        if (wasPaused) {
          stdin.pause();
        }
      };

      stdin.once("data", onData);
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
