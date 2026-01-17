import { expandGlob } from "@std/fs";
import { join, relative } from "@std/path";
import { type OutputOptions, verboseLog } from "./output.ts";

/**
 * Checks if a string contains glob pattern characters.
 * Returns true for patterns like `*.env` or `config/*.txt`
 */
export function isGlobPattern(pattern: string): boolean {
  return /[*?[\]{]/.test(pattern);
}

/**
 * Expands a single glob pattern to matching file paths.
 * Returns array of relative paths from repoRoot.
 */
export async function expandGlobPattern(
  pattern: string,
  repoRoot: string,
  options?: OutputOptions,
): Promise<string[]> {
  const files: string[] = [];

  try {
    // expandGlob requires an absolute path or a path relative to cwd
    const absolutePattern = join(repoRoot, pattern);

    for await (const entry of expandGlob(absolutePattern, { root: repoRoot })) {
      // Only include files, not directories
      if (entry.isFile) {
        // Convert to relative path from repoRoot
        const relativePath = relative(repoRoot, entry.path);

        // Security: Ensure the path does not escape repoRoot
        if (relativePath.startsWith("..")) {
          console.warn(
            `Warning: Skipping file outside repository: ${relativePath}`,
          );
          continue;
        }

        files.push(relativePath);
      }
    }
  } catch (error) {
    // Warn on actual errors (permission issues, invalid patterns, etc.)
    // but return empty array to allow continuation
    if (error instanceof Error) {
      console.warn(
        `Warning: Failed to expand glob pattern "${pattern}": ${error.message}`,
      );
    }
    return [];
  }

  return files;
}

/**
 * Expands all patterns (both exact paths and globs) to file paths.
 * Handles deduplication and maintains order.
 */
export async function expandCopyPatterns(
  patterns: string[],
  repoRoot: string,
  options?: OutputOptions,
): Promise<string[]> {
  const expandedFiles: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    if (isGlobPattern(pattern)) {
      // Expand glob pattern
      const matchedFiles = await expandGlobPattern(pattern, repoRoot, options);
      if (options?.verbose && matchedFiles.length === 0) {
        verboseLog(`No files matched for pattern: ${pattern}`, options ?? {});
      }
      for (const file of matchedFiles) {
        if (!seen.has(file)) {
          seen.add(file);
          expandedFiles.push(file);
        }
      }
    } else {
      // Treat as exact path
      if (!seen.has(pattern)) {
        seen.add(pattern);
        expandedFiles.push(pattern);
      }
    }
  }

  return expandedFiles;
}

/**
 * Checks if a path is a directory.
 */
async function isDir(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch {
    return false;
  }
}

/**
 * Expands a single glob pattern to matching directory paths.
 * Returns array of relative paths from repoRoot.
 */
async function expandGlobPatternForDirectories(
  pattern: string,
  repoRoot: string,
  options?: OutputOptions,
): Promise<string[]> {
  const dirs: string[] = [];

  try {
    const absolutePattern = join(repoRoot, pattern);
    verboseLog(`Expanding directory glob pattern: ${absolutePattern}`, options ?? {});

    for await (const entry of expandGlob(absolutePattern, { root: repoRoot })) {
      const isDirectory = entry.isDirectory;
      if (!isDirectory) {
        continue;
      }

      const relativePath = relative(repoRoot, entry.path);

      // Security: Ensure the path does not escape repoRoot
      const isOutsideRepo = relativePath.startsWith("..");
      if (isOutsideRepo) {
        console.warn(
          `Warning: Skipping directory outside repository: ${relativePath}`,
        );
        continue;
      }

      dirs.push(relativePath);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.warn(
        `Warning: Failed to expand directory pattern "${pattern}": ${error.message}`,
      );
    }
    return [];
  }

  return dirs;
}

/**
 * Expands directory patterns to actual directory paths.
 * Returns array of relative paths from repoRoot.
 * Supports exact paths and glob patterns (e.g., "node_modules", ".cache/*")
 */
export async function expandDirectoryPatterns(
  patterns: string[],
  repoRoot: string,
  options?: OutputOptions,
): Promise<string[]> {
  const expandedDirs: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    if (isGlobPattern(pattern)) {
      const matchedDirs = await expandGlobPatternForDirectories(pattern, repoRoot, options);
      if (options?.verbose && matchedDirs.length === 0) {
        verboseLog(`No directories matched for pattern: ${pattern}`, options ?? {});
      }
      for (const dir of matchedDirs) {
        if (!seen.has(dir)) {
          seen.add(dir);
          expandedDirs.push(dir);
        }
      }
    } else {
      // Security: Validate pattern
      const isAbsolutePath = pattern.startsWith("/");
      const hasNullByte = pattern.includes("\0");
      const isOutsideRepo = pattern.startsWith("..");

      if (isAbsolutePath || hasNullByte || isOutsideRepo) {
        console.warn(
          `Warning: Skipping invalid directory pattern: ${pattern}`,
        );
        continue;
      }

      // Treat as exact path - verify it's a directory
      const absolutePath = join(repoRoot, pattern);
      const isDirPath = await isDir(absolutePath);
      if (!isDirPath && options?.verbose) {
        verboseLog(`Directory not found or not a directory: ${absolutePath}`, options ?? {});
      }
      if (isDirPath && !seen.has(pattern)) {
        seen.add(pattern);
        expandedDirs.push(pattern);
      }
    }
  }

  return expandedDirs;
}
