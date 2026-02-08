import { join } from "node:path";
import { getRepoName, getRepoRoot, revisionExists, sanitizeBranchName } from "../utils/git.ts";
import type { VibeConfig } from "../types/config.ts";
import { loadVibeConfig } from "../utils/config.ts";
import { type HookTrackerInfo, runHooks } from "../utils/hooks.ts";
import { confirm, select } from "../utils/prompt.ts";
import { expandCopyPatterns, expandDirectoryPatterns } from "../utils/glob.ts";
import { ProgressTracker } from "../utils/progress.ts";
import { getCopyService } from "../utils/copy/index.ts";
import { loadUserSettings } from "../utils/settings.ts";
import { resolveWorktreePath } from "../utils/worktree-path.ts";
import { log, type OutputOptions, verboseLog, warnLog } from "../utils/output.ts";
import { formatCdCommand } from "../utils/shell.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";
import {
  checkWorktreeConflict,
  createWorktree,
  getCreateWorktreeCommand,
  removeWorktree,
  validateBranchForWorktree,
} from "../services/worktree/index.ts";

interface StartOptions extends OutputOptions {
  reuse?: boolean;
  noHooks?: boolean;
  noCopy?: boolean;
  dryRun?: boolean;
  base?: string;
  baseFromEquals?: boolean;
  track?: boolean;
}

interface ConfigAndHooksOptions {
  skipHooks?: boolean;
  skipCopy?: boolean;
  dryRun?: boolean;
}

function logDryRun(message: string): void {
  console.error(`[dry-run] ${message}`);
}

/**
 * Main start command - creates or navigates to a worktree
 */
export async function startCommand(
  branchName: string,
  options: StartOptions = {},
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const { runtime } = ctx;
  const {
    noHooks = false,
    noCopy = false,
    dryRun = false,
    verbose = false,
    quiet = false,
    base,
    baseFromEquals = false,
    track = false,
  } = options;
  const outputOpts: OutputOptions = { verbose, quiet };

  const isBranchNameEmpty = !branchName;
  if (isBranchNameEmpty) {
    console.error("Error: Branch name is required");
    runtime.control.exit(1);
  }

  const isBaseProvided = base !== undefined;
  if (isBaseProvided && typeof base !== "string") {
    console.error("Error: --base requires a value");
    runtime.control.exit(1);
  }
  const baseRef = typeof base === "string" ? base.trim() : undefined;
  if (isBaseProvided && baseRef === "") {
    console.error("Error: --base requires a value");
    runtime.control.exit(1);
  }
  if (isBaseProvided && baseRef && baseRef.startsWith("-") && !baseFromEquals) {
    console.error("Error: --base requires a value");
    runtime.control.exit(1);
  }

  try {
    const repoRoot = await getRepoRoot(ctx);
    const repoName = await getRepoName(ctx);
    const sanitizedBranch = sanitizeBranchName(branchName);

    verboseLog(`Repository root: ${repoRoot}`, outputOpts);
    verboseLog(`Repository name: ${repoName}`, outputOpts);
    verboseLog(`Sanitized branch: ${sanitizedBranch}`, outputOpts);

    // Validate branch for worktree creation
    const validation = await validateBranchForWorktree(branchName, ctx);
    const isBranchUsedInWorktree = !validation.isValid;

    if (isBranchUsedInWorktree) {
      const handled = await handleExistingBranchWorktree(
        branchName,
        validation.existingWorktreePath!,
        dryRun,
        ctx,
      );
      if (handled) return;
    }

    if (baseRef && validation.branchExists) {
      console.error(`Warning: Branch '${branchName}' already exists; --base is ignored.`);
    }

    if (baseRef && !validation.branchExists) {
      const baseExists = await revisionExists(baseRef, ctx);
      if (!baseExists) {
        console.error(`Error: Base '${baseRef}' not found`);
        runtime.control.exit(1);
      }
    }

    // Load settings and config
    const settings = await loadUserSettings(ctx);
    const config = await loadVibeConfig(repoRoot, ctx);

    // Resolve worktree path
    const worktreePath = await resolveWorktreePath(
      config,
      settings,
      {
        repoName,
        branchName,
        sanitizedBranch,
        repoRoot,
      },
      ctx,
    );

    // Create progress tracker
    const tracker = new ProgressTracker(
      {
        title: `Setting up worktree ${branchName}`,
      },
      ctx,
    );

    // Check for conflicts at target path
    const conflict = await checkWorktreeConflict(worktreePath, branchName, ctx);

    if (conflict.conflictType === "same-branch") {
      // Same branch - idempotent re-entry
      await handleSameBranchWorktree(
        config,
        repoRoot,
        worktreePath,
        tracker,
        { noHooks, noCopy, dryRun },
        outputOpts,
        ctx,
      );
      return;
    }

    if (conflict.hasConflict) {
      // Different branch - offer to overwrite
      const shouldContinue = await handleDifferentBranchConflict(
        config,
        repoRoot,
        worktreePath,
        conflict.existingBranch!,
        tracker,
        { noHooks, noCopy, dryRun },
        ctx,
      );
      if (!shouldContinue) return;
    }

    // Create the worktree
    const createOpts = {
      branchName,
      worktreePath,
      branchExists: validation.branchExists,
      baseRef: baseRef && !validation.branchExists ? baseRef : undefined,
      track,
    };

    if (dryRun) {
      const cmd = getCreateWorktreeCommand(createOpts);
      logDryRun(`Would run: ${cmd}`);
      logDryRun(`Worktree path: ${worktreePath}`);
    } else {
      const cmd = getCreateWorktreeCommand(createOpts);
      verboseLog(`Running: ${cmd}`, outputOpts);
      await createWorktree(createOpts, ctx);
    }

    // Run hooks and config
    await runConfigAndHooks(
      config,
      repoRoot,
      worktreePath,
      tracker,
      {
        skipHooks: noHooks,
        skipCopy: noCopy,
        dryRun,
      },
      ctx,
    );

    if (dryRun) {
      logDryRun(`Would change directory to: ${worktreePath}`);
    } else {
      console.log(formatCdCommand(worktreePath));
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    runtime.control.exit(1);
  }
}

/**
 * Handle case where branch is already used in another worktree
 * Returns true if the situation was fully handled (caller should return)
 */
async function handleExistingBranchWorktree(
  branchName: string,
  existingWorktreePath: string,
  dryRun: boolean,
  ctx: AppContext,
): Promise<boolean> {
  if (dryRun) {
    logDryRun(`Branch '${branchName}' is already used in worktree '${existingWorktreePath}'`);
    logDryRun(`Would navigate to: ${existingWorktreePath}`);
    return true;
  }

  const shouldNavigate = await confirm(
    `Branch '${branchName}' is already used in worktree '${existingWorktreePath}'.\nNavigate to the existing worktree? (Y/n)`,
    ctx,
  );

  if (shouldNavigate) {
    console.log(formatCdCommand(existingWorktreePath));
  } else {
    console.error("Cancelled");
  }
  ctx.runtime.control.exit(0);
  return true;
}

/**
 * Handle case where worktree already exists with the same branch
 */
async function handleSameBranchWorktree(
  config: VibeConfig | undefined,
  repoRoot: string,
  worktreePath: string,
  tracker: ProgressTracker,
  options: { noHooks: boolean; noCopy: boolean; dryRun: boolean },
  outputOpts: OutputOptions,
  ctx: AppContext,
): Promise<void> {
  const { noHooks, noCopy, dryRun } = options;

  if (dryRun) {
    logDryRun(`Worktree already exists at '${worktreePath}'`);
    logDryRun("Would run hooks and config, then navigate to worktree");
    await runConfigAndHooks(
      config,
      repoRoot,
      worktreePath,
      tracker,
      {
        skipHooks: noHooks,
        skipCopy: noCopy,
        dryRun,
      },
      ctx,
    );
    logDryRun(`Would change directory to: ${worktreePath}`);
    return;
  }

  log(`Note: Worktree already exists at '${worktreePath}'`, outputOpts);
  await runConfigAndHooks(
    config,
    repoRoot,
    worktreePath,
    tracker,
    {
      skipHooks: noHooks,
      skipCopy: noCopy,
    },
    ctx,
  );
  console.log(formatCdCommand(worktreePath));
}

/**
 * Handle case where worktree exists with a different branch
 * Returns true if we should continue with worktree creation
 */
async function handleDifferentBranchConflict(
  config: VibeConfig | undefined,
  repoRoot: string,
  worktreePath: string,
  existingBranch: string,
  tracker: ProgressTracker,
  options: { noHooks: boolean; noCopy: boolean; dryRun: boolean },
  ctx: AppContext,
): Promise<boolean> {
  const { noHooks, noCopy, dryRun } = options;

  if (dryRun) {
    logDryRun(`Directory '${worktreePath}' already exists (branch: ${existingBranch})`);
    logDryRun("Would prompt to Overwrite/Reuse/Cancel");
    return false;
  }

  const choice = await select(
    `Directory '${worktreePath}' already exists (branch: ${existingBranch}):`,
    ["Overwrite (remove and recreate)", "Reuse (use existing)", "Cancel"],
    ctx,
  );

  if (choice === 0) {
    // Overwrite: remove existing worktree
    await removeWorktree({ worktreePath, force: true }, ctx);
    return true;
  }

  if (choice === 1) {
    // Reuse: skip git worktree creation, run hooks/config
    await runConfigAndHooks(
      config,
      repoRoot,
      worktreePath,
      tracker,
      {
        skipHooks: noHooks,
        skipCopy: noCopy,
      },
      ctx,
    );
    console.log(formatCdCommand(worktreePath));
    return false;
  }

  // Cancel
  console.error("Cancelled");
  ctx.runtime.control.exit(0);
  return false;
}

/**
 * Run hooks and copy operations based on config
 */
async function runConfigAndHooks(
  config: VibeConfig | undefined,
  repoRoot: string,
  worktreePath: string,
  tracker: ProgressTracker,
  options: ConfigAndHooksOptions = {},
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const { skipHooks = false, skipCopy = false, dryRun = false } = options;

  const hooksCount = skipHooks
    ? 0
    : (config?.hooks?.pre_start?.length ?? 0) + (config?.hooks?.post_start?.length ?? 0);
  const copyCount = skipCopy
    ? 0
    : (config?.copy?.files?.length ?? 0) + (config?.copy?.dirs?.length ?? 0);
  const hasOperations = config !== undefined && hooksCount + copyCount > 0;

  const shouldStartTracker = !dryRun && hasOperations;
  if (shouldStartTracker) {
    tracker.start();
  }

  if (!skipHooks) {
    await runPreStartHooks(config, repoRoot, worktreePath, tracker, dryRun, ctx);
  }

  if (config !== undefined) {
    await runCopyAndPostHooks(
      config,
      repoRoot,
      worktreePath,
      tracker,
      {
        skipHooks,
        skipCopy,
        dryRun,
      },
      ctx,
    );
  }

  if (shouldStartTracker) {
    await tracker.finish();
  }
}

/**
 * Run pre-start hooks if configured
 */
async function runPreStartHooks(
  config: VibeConfig | undefined,
  repoRoot: string,
  worktreePath: string,
  tracker: ProgressTracker,
  dryRun: boolean,
  ctx: AppContext,
): Promise<void> {
  const preStartHooks = config?.hooks?.pre_start;
  const hasPreStartHooks = preStartHooks !== undefined && preStartHooks.length > 0;

  if (!hasPreStartHooks) return;

  if (dryRun) {
    logDryRun("Would run pre-start hooks:");
    for (const hook of preStartHooks) {
      logDryRun(`  - ${hook}`);
    }
    return;
  }

  const phaseId = tracker.addPhase("Pre-start hooks");
  const taskIds = preStartHooks.map((hook) => tracker.addTask(phaseId, hook));
  const trackerInfo: HookTrackerInfo = { tracker, taskIds };

  await runHooks(
    preStartHooks,
    repoRoot,
    {
      worktreePath,
      originPath: repoRoot,
    },
    trackerInfo,
    ctx,
  );
}

/**
 * Run copy operations and post-start hooks
 */
async function runCopyAndPostHooks(
  config: VibeConfig,
  repoRoot: string,
  worktreePath: string,
  tracker: ProgressTracker,
  options: ConfigAndHooksOptions,
  ctx: AppContext,
): Promise<void> {
  const { skipHooks = false, skipCopy = false, dryRun = false } = options;

  const copyService = getCopyService(ctx);

  // Copy files
  if (!skipCopy) {
    const concurrency = resolveCopyConcurrency(config, ctx);
    await copyFiles(config, repoRoot, worktreePath, tracker, copyService, dryRun);
    await copyDirectories(
      config,
      repoRoot,
      worktreePath,
      tracker,
      copyService,
      dryRun,
      concurrency,
      ctx,
    );
  }

  // Run post-start hooks
  if (!skipHooks) {
    await runPostStartHooks(config, repoRoot, worktreePath, tracker, dryRun, ctx);
  }
}

/**
 * Copy files from origin to worktree
 */
async function copyFiles(
  config: VibeConfig,
  repoRoot: string,
  worktreePath: string,
  tracker: ProgressTracker,
  copyService: ReturnType<typeof getCopyService>,
  dryRun: boolean,
): Promise<void> {
  const filesToCopy = await expandCopyPatterns(config.copy?.files ?? [], repoRoot);

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
    const src = join(repoRoot, file);
    const dest = join(worktreePath, file);

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
async function withConcurrencyLimit<T>(
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
 * Copy directories from origin to worktree
 */
async function copyDirectories(
  config: VibeConfig,
  repoRoot: string,
  worktreePath: string,
  tracker: ProgressTracker,
  copyService: ReturnType<typeof getCopyService>,
  dryRun: boolean,
  concurrency: number,
  ctx: AppContext,
): Promise<void> {
  const directoriesToCopy = await expandDirectoryPatterns(config.copy?.dirs ?? [], repoRoot, ctx);

  if (directoriesToCopy.length === 0) return;

  if (dryRun) {
    logDryRun("Would copy directories:");
    for (const dir of directoriesToCopy) {
      logDryRun(`  - ${dir}`);
    }
    return;
  }

  const dirStrategy = await copyService.getDirectoryStrategy();
  const phaseId = tracker.addPhase(`Copying directories (${dirStrategy.name})`);
  const taskIds = directoriesToCopy.map((dir) => tracker.addTask(phaseId, dir));

  await withConcurrencyLimit(directoriesToCopy, concurrency, async (dir, i) => {
    const src = join(repoRoot, dir);
    const dest = join(worktreePath, dir);

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

/**
 * Run post-start hooks if configured
 */
async function runPostStartHooks(
  config: VibeConfig,
  repoRoot: string,
  worktreePath: string,
  tracker: ProgressTracker,
  dryRun: boolean,
  ctx: AppContext,
): Promise<void> {
  const postStartHooks = config.hooks?.post_start;
  const hasPostStartHooks = postStartHooks !== undefined && postStartHooks.length > 0;

  if (!hasPostStartHooks) return;

  if (dryRun) {
    logDryRun("Would run post-start hooks:");
    for (const hook of postStartHooks) {
      logDryRun(`  - ${hook}`);
    }
    return;
  }

  const phaseId = tracker.addPhase("Post-start hooks");
  const taskIds = postStartHooks.map((hook) => tracker.addTask(phaseId, hook));
  const trackerInfo: HookTrackerInfo = { tracker, taskIds };

  await runHooks(
    postStartHooks,
    worktreePath,
    {
      worktreePath,
      originPath: repoRoot,
    },
    trackerInfo,
    ctx,
  );
}
