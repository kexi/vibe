import { dirname } from "node:path";
import { detectCapabilities } from "../detector.ts";
import type { CopyStrategy } from "../types.ts";
import { validatePath } from "../validation.ts";
import { runtime } from "../../../runtime/index.ts";

/**
 * Robocopy-based copy strategy (Windows only).
 *
 * Uses the multithreaded `robocopy /MT` to accelerate copying directories with
 * many small files (e.g. node_modules) into a worktree. Robocopy is bundled
 * with Windows, needs no elevation, and works on any NTFS volume.
 */
export class RobocopyStrategy implements CopyStrategy {
  readonly name = "robocopy" as const;

  async isAvailable(): Promise<boolean> {
    const capabilities = await detectCapabilities();
    return capabilities.robocopyAvailable;
  }

  async copyFile(src: string, dest: string): Promise<void> {
    // Robocopy is a directory-level tool, so single files are copied with the
    // plain runtime copy (matching StandardStrategy.copyFile semantics).
    validatePath(src);
    validatePath(dest);

    const destDir = dirname(dest);
    await runtime.fs.mkdir(destDir, { recursive: true }).catch(() => {});

    await runtime.fs.copyFile(src, dest);
  }

  async copyDirectory(src: string, dest: string): Promise<void> {
    // Validate paths to prevent command injection
    validatePath(src);
    validatePath(dest);

    // Ensure parent directory exists
    const destDir = dirname(dest);
    await runtime.fs.mkdir(destDir, { recursive: true }).catch(() => {});

    const result = await runtime.process.run({
      cmd: "robocopy",
      args: [
        src,
        dest,
        // /E copies subdirectories including empty ones: robocopy maps
        // src's *contents* into dest, matching copyDirectory(src, dest).
        "/E",
        // /MT runs the copy multithreaded (default 8 threads).
        "/MT",
        // Suppress per-file/dir logging, job header/summary, and the progress
        // percentage so output stays small and needs no parsing.
        "/NFL",
        "/NDL",
        "/NJH",
        "/NJS",
        "/NP",
        // Cap retries: robocopy defaults to 1 million retries with a 30s wait,
        // which would hang on a transient failure instead of falling back.
        "/R:1",
        "/W:1",
      ],
      stdout: "piped",
      stderr: "piped",
    });

    // Robocopy uses bitmask exit codes: 0-7 indicate success (files copied,
    // extra files, mismatches), 8+ indicate failure. result.success
    // (code === 0) would wrongly reject a normal successful copy (code 1).
    const isRobocopySuccess = result.code < 8;
    if (!isRobocopySuccess) {
      // Robocopy writes its diagnostics (e.g. "ERROR 5 ... Access is denied")
      // to stdout, not stderr, so the failure detail lives in stdout; stderr is
      // appended only as a fallback for the rare message that lands there.
      const stdout = new TextDecoder().decode(result.stdout).trim();
      const stderr = new TextDecoder().decode(result.stderr).trim();
      const detail = [stdout, stderr].filter(Boolean).join(" ");
      throw new Error(
        `Robocopy directory copy failed (code ${result.code}): ${src} -> ${dest}: ${detail}`,
      );
    }
  }
}
