import { cp } from "node:fs/promises";
import { dirname } from "node:path";
import type { CopyStrategy } from "../types.ts";
import { runtime } from "../../../runtime/index.ts";

/**
 * Standard copy strategy using runtime's built-in APIs.
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
    await runtime.fs.mkdir(destDir, { recursive: true }).catch(() => {});

    await runtime.fs.copyFile(src, dest);
  }

  async copyDirectory(src: string, dest: string): Promise<void> {
    await cp(src, dest, { recursive: true, force: true });
  }
}
