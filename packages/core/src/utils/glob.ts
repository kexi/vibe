import fg from "fast-glob";
import { join } from "node:path";
import { type AppContext, getGlobalContext } from "../context/index.ts";

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
export async function expandGlobPattern(pattern: string, repoRoot: string): Promise<string[]> {
  const files: string[] = [];

  // Security: Reject absolute paths to prevent accessing files outside repository
  const isAbsolutePath = pattern.startsWith("/");
  if (isAbsolutePath) {
    console.warn(`Warning: Skipping absolute path pattern: ${pattern}`);
    return [];
  }

  try {
    // fast-glob returns relative paths when using cwd option
    const entries = await fg(pattern, {
      cwd: repoRoot,
      onlyFiles: true,
      dot: true,
    });

    for (const entry of entries) {
      // Security: Ensure the path does not escape repoRoot
      const isOutsideRepo = entry.startsWith("..");
      if (isOutsideRepo) {
        console.warn(`Warning: Skipping file outside repository: ${entry}`);
        continue;
      }

      files.push(entry);
    }
  } catch (error) {
    // Warn on actual errors (permission issues, invalid patterns, etc.)
    // but return empty array to allow continuation
    if (error instanceof Error) {
      console.warn(`Warning: Failed to expand glob pattern "${pattern}": ${error.message}`);
    }
    return [];
  }

  return files;
}

/**
 * Expands all patterns (both exact paths and globs) to file paths.
 * Handles deduplication and maintains order.
 */
export async function expandCopyPatterns(patterns: string[], repoRoot: string): Promise<string[]> {
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

/**
 * Checks if a path is a directory.
 */
async function isDir(path: string, ctx: AppContext): Promise<boolean> {
  try {
    const stat = await ctx.runtime.fs.stat(path);
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
): Promise<string[]> {
  const dirs: string[] = [];

  try {
    // fast-glob with onlyDirectories
    const entries = await fg(pattern, {
      cwd: repoRoot,
      onlyDirectories: true,
      dot: true,
    });

    for (const entry of entries) {
      // Security: Ensure the path does not escape repoRoot
      const isOutsideRepo = entry.startsWith("..");
      if (isOutsideRepo) {
        console.warn(`Warning: Skipping directory outside repository: ${entry}`);
        continue;
      }

      dirs.push(entry);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.warn(`Warning: Failed to expand directory pattern "${pattern}": ${error.message}`);
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
  ctx: AppContext = getGlobalContext(),
): Promise<string[]> {
  const expandedDirs: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    if (isGlobPattern(pattern)) {
      const matchedDirs = await expandGlobPatternForDirectories(pattern, repoRoot);
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
        console.warn(`Warning: Skipping invalid directory pattern: ${pattern}`);
        continue;
      }

      // Treat as exact path - verify it's a directory
      const absolutePath = join(repoRoot, pattern);
      const isDirPath = await isDir(absolutePath, ctx);
      if (isDirPath && !seen.has(pattern)) {
        seen.add(pattern);
        expandedDirs.push(pattern);
      }
    }
  }

  return expandedDirs;
}
