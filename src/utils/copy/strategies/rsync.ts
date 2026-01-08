import { dirname } from "@std/path";
import { detectCapabilities } from "../detector.ts";
import type { CopyStrategy } from "../types.ts";
import { validatePath } from "../validation.ts";

/**
 * Rsync-based copy strategy.
 * Efficient for large files and incremental updates.
 */
export class RsyncStrategy implements CopyStrategy {
  readonly name = "rsync" as const;

  async isAvailable(): Promise<boolean> {
    const capabilities = await detectCapabilities();
    return capabilities.rsyncAvailable;
  }

  async copyFile(src: string, dest: string): Promise<void> {
    // Validate paths to prevent command injection
    validatePath(src);
    validatePath(dest);

    // Ensure parent directory exists
    const destDir = dirname(dest);
    await Deno.mkdir(destDir, { recursive: true }).catch(() => {});

    const cmd = new Deno.Command("rsync", {
      args: ["-a", src, dest],
      stderr: "piped",
    });
    const result = await cmd.output();

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Rsync copy failed: ${src} -> ${dest}: ${stderr}`);
    }
  }

  async copyDirectory(src: string, dest: string): Promise<void> {
    // Validate paths to prevent command injection
    validatePath(src);
    validatePath(dest);

    // Ensure parent directory exists
    const destDir = dirname(dest);
    await Deno.mkdir(destDir, { recursive: true }).catch(() => {});

    // rsync requires trailing slash on src to copy contents
    // Without trailing slash, it copies the directory itself into dest
    const srcPath = src.endsWith("/") ? src : `${src}/`;

    // Note: --delete is intentionally NOT used to prevent data loss
    const cmd = new Deno.Command("rsync", {
      args: ["-a", srcPath, dest],
      stderr: "piped",
    });
    const result = await cmd.output();

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(
        `Rsync directory copy failed: ${src} -> ${dest}: ${stderr}`,
      );
    }
  }
}
