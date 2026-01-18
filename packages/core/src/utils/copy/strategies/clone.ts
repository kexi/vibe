import { dirname } from "@std/path";
import { detectCapabilities } from "../detector.ts";
import type { CopyStrategy } from "../types.ts";
import { validatePath } from "../validation.ts";
import { runtime } from "../../../runtime/index.ts";

/**
 * Clone (Copy-on-Write) strategy using filesystem-level cloning.
 * - macOS (APFS): Uses `cp -c`
 * - Linux (Btrfs/XFS): Uses `cp --reflink=auto`
 */
export class CloneStrategy implements CopyStrategy {
  readonly name = "clone" as const;

  async isAvailable(): Promise<boolean> {
    const capabilities = await detectCapabilities();
    return capabilities.cloneSupported;
  }

  async copyFile(src: string, dest: string): Promise<void> {
    // Validate paths to prevent command injection
    validatePath(src);
    validatePath(dest);

    // Ensure parent directory exists
    const destDir = dirname(dest);
    await runtime.fs.mkdir(destDir, { recursive: true }).catch(() => {});

    const args = this.getCloneArgs(src, dest, false);
    const result = await runtime.process.run({
      cmd: "cp",
      args,
      stderr: "piped",
    });

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Clone copy failed: ${src} -> ${dest}: ${stderr}`);
    }
  }

  async copyDirectory(src: string, dest: string): Promise<void> {
    // Validate paths to prevent command injection
    validatePath(src);
    validatePath(dest);

    // Ensure parent directory exists
    const destDir = dirname(dest);
    await runtime.fs.mkdir(destDir, { recursive: true }).catch(() => {});

    const args = this.getCloneArgs(src, dest, true);
    const result = await runtime.process.run({
      cmd: "cp",
      args,
      stderr: "piped",
    });

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(
        `Clone directory copy failed: ${src} -> ${dest}: ${stderr}`,
      );
    }
  }

  /**
   * Get the appropriate cp arguments for the current OS
   */
  private getCloneArgs(
    src: string,
    dest: string,
    recursive: boolean,
  ): string[] {
    const os = runtime.build.os;

    if (os === "darwin") {
      // macOS: cp -c (clone) or cp -cR (recursive clone)
      const cloneFlag = recursive ? "-cR" : "-c";
      return [cloneFlag, src, dest];
    }

    // Linux: cp --reflink=auto or cp -r --reflink=auto
    if (recursive) {
      return ["-r", "--reflink=auto", src, dest];
    }
    return ["--reflink=auto", src, dest];
  }
}
