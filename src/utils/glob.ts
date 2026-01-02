import { expandGlob } from "@std/fs";
import { join, relative } from "@std/path";

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
): Promise<string[]> {
  const expandedFiles: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    if (isGlobPattern(pattern)) {
      // Expand glob pattern
      const matchedFiles = await expandGlobPattern(pattern, repoRoot);
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
