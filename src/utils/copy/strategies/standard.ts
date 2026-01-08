import { copy } from "@std/fs/copy";
import { dirname } from "@std/path";
import type { CopyStrategy } from "../types.ts";

/**
 * Standard copy strategy using Deno's built-in APIs.
 * This is the fallback strategy that works on all platforms.
 */
export class StandardStrategy implements CopyStrategy {
  readonly name = "standard" as const;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    // Ensure parent directory exists
    const destDir = dirname(dest);
    await Deno.mkdir(destDir, { recursive: true }).catch(() => {});

    await Deno.copyFile(src, dest);
  }

  async copyDirectory(src: string, dest: string): Promise<void> {
    await copy(src, dest, { overwrite: true });
  }
}
