import { getRepoName, getRepoRoot, revisionExists, sanitizeBranchName } from "../utils/git.ts";
import type { VibeConfig } from "../types/config.ts";
import { loadVibeConfig } from "../utils/config.ts";
import { type HookTrackerInfo, runHooks } from "../utils/hooks.ts";
import { confirm, select } from "../utils/prompt.ts";
import { ProgressTracker } from "../utils/progress.ts";
import { getCopyService } from "../utils/copy/index.ts";
import { copyFiles, copyDirectories, resolveCopyConcurrency } from "../utils/copy-runner.ts";
import { loadUserSettings } from "../utils/settings.ts";
import { resolveWorktreePath } from "../utils/worktree-path.ts";
import { readWorktreeHookName } from "../utils/stdin.ts";
import {
  errorLog,
  log,
  logDryRun,
  type OutputOptions,
  verboseLog,
  warnLog,
} from "../utils/output.ts";
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
  worktreeHook?: boolean;
}

interface ConfigAndHooksOptions {
  skipHooks?: boolean;
  skipCopy?: boolean;
  dryRun?: boolean;
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
    worktreeHook = false,
  } = options;
  const outputOpts: OutputOptions = { verbose, quiet };

  // Claude Code WorktreeCreate hook mode: full start flow with stdin name, stdout path
  const isWorktreeHookMode = worktreeHook;
  if (isWorktreeHookMode) {
    await startWorktreeHookMode(
      branchName,
      { noHooks, noCopy, dryRun, base, track },
      outputOpts,
      ctx,
    );
    return;
  }

  const isBranchNameEmpty = !branchName;
  if (isBranchNameEmpty) {
    errorLog("Error: Branch name is required", outputOpts);
    runtime.control.exit(1);
  }

  const isBaseProvided = base !== undefined;
  if (isBaseProvided && typeof base !== "string") {
    errorLog("Error: --base requires a value", outputOpts);
    runtime.control.exit(1);
  }
  const baseRef = typeof base === "string" ? base.trim() : undefined;
  if (isBaseProvided && baseRef === "") {
    errorLog("Error: --base requires a value", outputOpts);
    runtime.control.exit(1);
  }
  if (isBaseProvided && baseRef && baseRef.startsWith("-") && !baseFromEquals) {
    errorLog("Error: --base requires a value", outputOpts);
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
      warnLog(`Warning: Branch '${branchName}' already exists; --base is ignored.`);
    }

    if (baseRef && !validation.branchExists) {
      const baseExists = await revisionExists(baseRef, ctx);
      if (!baseExists) {
        errorLog(`Error: Base '${baseRef}' not found`, outputOpts);
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
    errorLog(`Error: ${errorMessage}`, outputOpts);
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
    log("Cancelled", { quiet: false });
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
  log("Cancelled", { quiet: false });
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
    await copyFiles(config.copy?.files ?? [], repoRoot, worktreePath, tracker, copyService, dryRun);

    const hasDirs = (config.copy?.dirs?.length ?? 0) > 0;
    if (hasDirs) {
      const concurrency = resolveCopyConcurrency(config, ctx);
      await copyDirectories(
        config.copy?.dirs ?? [],
        repoRoot,
        worktreePath,
        tracker,
        copyService,
        dryRun,
        concurrency,
        ctx,
      );
    }
  }

  // Run post-start hooks
  if (!skipHooks) {
    await runPostStartHooks(config, repoRoot, worktreePath, tracker, dryRun, ctx);
  }
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

/**
 * Claude Code WorktreeCreate hook mode.
 *
 * Replaces Claude Code's default git worktree creation with the full vibe start flow.
 * Reads the worktree name from stdin JSON (WorktreeCreate hook format: {"name": "..."}).
 * Outputs the worktree path to stdout (required by WorktreeCreate hook protocol).
 *
 * Flow:
 * 1. Read name from stdin (or use CLI branch name argument)
 * 2. Full start flow: pre_start hooks → worktree creation → copy → post_start hooks
 * 3. Output worktree path to stdout
 */
async function startWorktreeHookMode(
  cliBranchName: string,
  options: {
    noHooks: boolean;
    noCopy: boolean;
    dryRun: boolean;
    base?: string;
    track: boolean;
  },
  outputOpts: OutputOptions,
  ctx: AppContext,
): Promise<void> {
  const { noHooks, noCopy, dryRun, base, track } = options;

  // Resolve branch name: CLI argument takes precedence, then stdin name
  const stdinName = cliBranchName ? undefined : await readWorktreeHookName(ctx);
  const branchName = cliBranchName || stdinName;

  const hasBranchName = branchName !== undefined && branchName.length > 0;
  if (!hasBranchName) {
    errorLog(
      "Error: --claude-code-worktree-hook requires a name via stdin or branch argument",
      outputOpts,
    );
    ctx.runtime.control.exit(1);
    return;
  }

  try {
    const repoRoot = await getRepoRoot(ctx);
    const repoName = await getRepoName(ctx);
    const sanitizedBranch = sanitizeBranchName(branchName);

    verboseLog(`[cc-worktree-hook] Repository root: ${repoRoot}`, outputOpts);
    verboseLog(`[cc-worktree-hook] Branch name: ${branchName}`, outputOpts);

    // Validate branch for worktree creation
    const validation = await validateBranchForWorktree(branchName, ctx);

    // In worktree-hook mode, if branch is already used in a worktree, output existing path
    const isBranchUsedInWorktree = !validation.isValid;
    if (isBranchUsedInWorktree) {
      const existingPath = validation.existingWorktreePath!;
      verboseLog(`[cc-worktree-hook] Branch already in worktree: ${existingPath}`, outputOpts);
      if (!dryRun) {
        console.log(existingPath);
      }
      return;
    }

    const baseRef = typeof base === "string" ? base.trim() : undefined;
    if (baseRef && !validation.branchExists) {
      const baseExists = await revisionExists(baseRef, ctx);
      if (!baseExists) {
        errorLog(`Error: Base '${baseRef}' not found`, outputOpts);
        ctx.runtime.control.exit(1);
        return;
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

    verboseLog(`[cc-worktree-hook] Worktree path: ${worktreePath}`, outputOpts);

    // Check for conflicts at target path
    const conflict = await checkWorktreeConflict(worktreePath, branchName, ctx);

    if (conflict.conflictType === "same-branch") {
      // Same branch exists - reuse: run hooks/config, output existing path
      const tracker = new ProgressTracker({ title: `Setting up worktree ${branchName}` }, ctx);
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
      if (!dryRun) {
        console.log(worktreePath);
      }
      return;
    }

    if (conflict.hasConflict) {
      // Different branch at same path - force remove and recreate
      await removeWorktree({ worktreePath, force: true }, ctx);
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
      logDryRun(`[cc-worktree-hook] Would run: ${cmd}`);
      logDryRun(`[cc-worktree-hook] Worktree path: ${worktreePath}`);
    } else {
      const cmd = getCreateWorktreeCommand(createOpts);
      verboseLog(`[cc-worktree-hook] Running: ${cmd}`, outputOpts);
      await createWorktree(createOpts, ctx);
    }

    // Create progress tracker
    const tracker = new ProgressTracker({ title: `Setting up worktree ${branchName}` }, ctx);

    // Run hooks and config (post_start hook failures are non-fatal for worktree creation)
    try {
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
    } catch (error) {
      // Log hook/copy failures but don't fail worktree creation
      const errorMessage = error instanceof Error ? error.message : String(error);
      warnLog(`Warning: Post-setup failed: ${errorMessage}`);
    }

    // Output worktree path to stdout (required by WorktreeCreate hook protocol)
    if (!dryRun) {
      console.log(worktreePath);
    } else {
      logDryRun(`[cc-worktree-hook] Would output path: ${worktreePath}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    errorLog(`Error: ${errorMessage}`, outputOpts);
    ctx.runtime.control.exit(1);
  }
}
