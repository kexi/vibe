import { dirname } from "node:path";
import { detectCapabilities } from "../detector.ts";
import type { CopyStrategy } from "../types.ts";
import { validatePath } from "../validation.ts";
import { runtime } from "../../../runtime/index.ts";

/**
 * Robocopy-based copy strategy for Windows.
 * Uses multi-threaded copying (/MT flag) for efficient directory operations.
 *
 * Important: robocopy exit codes 0-7 indicate success:
 *   0: No files copied, no errors
 *   1: One or more files copied
 *   2: Extra files/dirs detected (not an error)
 *   3: Combination of 1+2
 *   4: Mismatched files/dirs detected
 *   5-7: Combinations of above
 *   8+: Errors occurred
 */
export class RobocopyStrategy implements CopyStrategy {
  readonly name = "robocopy" as const;

  async isAvailable(): Promise<boolean> {
    const capabilities = await detectCapabilities();
    return capabilities.robocopyAvailable;
  }

  /**
   * Copy a single file using robocopy.
   * Note: CopyService always uses StandardStrategy for single file copies,
   * so this is primarily for interface compliance.
   */
  async copyFile(src: string, dest: string): Promise<void> {
    validatePath(src);
    validatePath(dest);

    const srcDir = dirname(src);
    const destDir = dirname(dest);
    const fileName = src.split(/[\\/]/).pop()!;

    // Ensure destination directory exists
    await runtime.fs.mkdir(destDir, { recursive: true }).catch(() => {});

    const result = await runtime.process.run({
      cmd: "robocopy",
      args: [
        srcDir,
        destDir,
        fileName,
        "/COPY:DAT",
        "/DCOPY:DAT",
        "/NFL",
        "/NDL",
        "/NJH",
        "/NJS",
        "/NC",
        "/NS",
        "/NP",
      ],
      stderr: "piped",
    });

    // robocopy exit codes: 0-7 = success, 8+ = error
    if (result.code >= 8) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Robocopy file copy failed: ${src} -> ${dest}: ${stderr}`);
    }
  }

  async copyDirectory(src: string, dest: string): Promise<void> {
    validatePath(src);
    validatePath(dest);

    // Ensure parent directory exists
    const parentDir = dirname(dest);
    await runtime.fs.mkdir(parentDir, { recursive: true }).catch(() => {});

    // /E: Copy subdirectories including empty ones
    // /MT: Multi-threaded copying (default 8 threads)
    // /COPY:DAT: Copy Data, Attributes, Timestamps
    // /DCOPY:DAT: Copy Directory Data, Attributes, Timestamps
    // /NFL /NDL /NJH /NJS /NC /NS /NP: Suppress output for performance
    // Note: /PURGE and /MIR are intentionally NOT used to prevent data loss
    const result = await runtime.process.run({
      cmd: "robocopy",
      args: [
        src,
        dest,
        "/E",
        "/MT",
        "/COPY:DAT",
        "/DCOPY:DAT",
        "/NFL",
        "/NDL",
        "/NJH",
        "/NJS",
        "/NC",
        "/NS",
        "/NP",
      ],
      stderr: "piped",
    });

    // robocopy exit codes: 0-7 = success, 8+ = error
    if (result.code >= 8) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Robocopy directory copy failed: ${src} -> ${dest}: ${stderr}`);
    }
  }
}
