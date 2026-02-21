import { join } from "node:path";
import { expandCopyPatterns, expandDirectoryPatterns } from "./glob.ts";
import { ProgressTracker } from "./progress.ts";
import type { CopyService } from "./copy/index.ts";
import { logDryRun, warnLog } from "./output.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";
import type { VibeConfig } from "../types/config.ts";

const DEFAULT_COPY_CONCURRENCY = 4;
const MAX_COPY_CONCURRENCY = 32;

/**
 * Resolve the copy concurrency value from environment variable, config, or default.
 *
 * Priority order:
 * 1. Environment variable `VIBE_COPY_CONCURRENCY` (highest priority)
 * 2. Config file setting `copy.concurrency`
 * 3. Default value (4)
 *
 * If the environment variable is set but invalid (not an integer between 1-32),
 * a warning is logged and the default value is used (not the config value).
 *
 * @param config - The vibe configuration object (may be undefined)
 * @param ctx - The application context for accessing environment variables
 * @returns The resolved concurrency value (1-32)
 */
export function resolveCopyConcurrency(config: VibeConfig | undefined, ctx: AppContext): number {
  // Check environment variable first (highest priority)
  const envValue = ctx.runtime.env.get("VIBE_COPY_CONCURRENCY");
  if (envValue !== undefined) {
    const parsed = parseInt(envValue, 10);
    const isValidEnvValue = !isNaN(parsed) && parsed >= 1 && parsed <= MAX_COPY_CONCURRENCY;
    if (isValidEnvValue) {
      return parsed;
    }
    warnLog(
      `Warning: Invalid VIBE_COPY_CONCURRENCY value '${envValue}'. ` +
        `Must be an integer between 1 and ${MAX_COPY_CONCURRENCY}. Using default: ${DEFAULT_COPY_CONCURRENCY}`,
    );
    return DEFAULT_COPY_CONCURRENCY;
  }

  // Fall back to config value
  const configValue = config?.copy?.concurrency;
  if (configValue !== undefined) {
    return configValue;
  }

  // Use default
  return DEFAULT_COPY_CONCURRENCY;
}

/**
 * Execute tasks with concurrency limit.
 * Limits the number of concurrent operations to avoid overwhelming system resources.
 */
export async function withConcurrencyLimit<T>(
  items: T[],
  limit: number,
  handler: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let index = 0;
  const executeNext = async (): Promise<void> => {
    if (index >= items.length) return;
    const currentIndex = index++;
    await handler(items[currentIndex], currentIndex);
    await executeNext();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, executeNext));
}

/**
 * Copy files from origin to worktree
 */
export async function copyFiles(
  filePatterns: string[],
  originPath: string,
  targetPath: string,
  tracker: ProgressTracker,
  copyService: CopyService,
  dryRun: boolean,
): Promise<void> {
  const filesToCopy = await expandCopyPatterns(filePatterns, originPath);

  if (filesToCopy.length === 0) return;

  if (dryRun) {
    logDryRun("Would copy files:");
    for (const file of filesToCopy) {
      logDryRun(`  - ${file}`);
    }
    return;
  }

  const phaseId = tracker.addPhase("Copying files");
  const taskIds = filesToCopy.map((file) => tracker.addTask(phaseId, file));

  for (let i = 0; i < filesToCopy.length; i++) {
    const file = filesToCopy[i];
    const src = join(originPath, file);
    const dest = join(targetPath, file);

    tracker.startTask(taskIds[i]);
    try {
      await copyService.copyFile(src, dest);
      tracker.completeTask(taskIds[i]);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      tracker.failTask(taskIds[i], errorMessage);
      console.warn(`Warning: Failed to copy ${file}: ${errorMessage}`);
    }
  }
}

/**
 * Copy directories from origin to worktree
 */
export async function copyDirectories(
  dirPatterns: string[],
  originPath: string,
  targetPath: string,
  tracker: ProgressTracker,
  copyService: CopyService,
  dryRun: boolean,
  concurrency: number,
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const directoriesToCopy = await expandDirectoryPatterns(dirPatterns, originPath, ctx);

  if (directoriesToCopy.length === 0) return;

  if (dryRun) {
    logDryRun("Would copy directories:");
    for (const dir of directoriesToCopy) {
      logDryRun(`  - ${dir}`);
    }
    return;
  }

  const dirStrategy = await copyService.getDirectoryStrategy();
  if (process.env.VIBE_DEBUG) {
    console.error(`[vibe] Copy strategy: ${dirStrategy.name}`);
  }
  const phaseId = tracker.addPhase(`Copying directories (${dirStrategy.name})`);
  const taskIds = directoriesToCopy.map((dir) => tracker.addTask(phaseId, dir));

  await withConcurrencyLimit(directoriesToCopy, concurrency, async (dir, i) => {
    const src = join(originPath, dir);
    const dest = join(targetPath, dir);

    tracker.startTask(taskIds[i]);
    try {
      await copyService.copyDirectory(src, dest);
      tracker.completeTask(taskIds[i]);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      tracker.failTask(taskIds[i], errorMessage);
      console.warn(`Warning: Failed to copy directory ${dir}: ${errorMessage}`);
    }
  });
}
