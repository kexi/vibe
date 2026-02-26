import { isAbsolute } from "node:path";
import { getMainWorktreePath, getRepoRoot } from "../utils/git.ts";
import { loadVibeConfig } from "../utils/config.ts";
import { ProgressTracker } from "../utils/progress.ts";
import { getCopyService } from "../utils/copy/index.ts";
import { copyFiles, copyDirectories, resolveCopyConcurrency } from "../utils/copy-runner.ts";
import { validatePath } from "../utils/copy/validation.ts";
import { readTargetFromStdin } from "../utils/stdin.ts";
import { errorLog, log, type OutputOptions, verboseLog } from "../utils/output.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";

interface CopyOptions extends OutputOptions {
  target?: string;
  dryRun?: boolean;
}

/**
 * Copy command - copies files/directories from main worktree to target using CoW
 *
 * Used standalone or invoked by Claude Code's PostToolUse hook for EnterWorktree.
 *
 * Target resolution order:
 * 1. --target option (explicit)
 * 2. stdin JSON .cwd field (hook mode)
 * 3. current git repo root (standalone mode)
 */
export async function copyCommand(
  options: CopyOptions = {},
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const { target, dryRun = false, verbose = false, quiet = false } = options;
  const outputOpts: OutputOptions = { verbose, quiet };

  try {
    // Security: validate --target option for defense-in-depth consistency with stdin handling
    if (target !== undefined) {
      const isAbsoluteTarget = isAbsolute(target);
      if (!isAbsoluteTarget) {
        errorLog("Error: --target must be an absolute path.", outputOpts);
        ctx.runtime.control.exit(1);
        return;
      }
      validatePath(target);
    }

    // Determine target path: --target > stdin .cwd > getRepoRoot()
    const stdinTarget = target === undefined ? await readTargetFromStdin(ctx) : undefined;
    const targetPath = target ?? stdinTarget ?? (await getRepoRoot(ctx));

    // Determine origin (main worktree) path
    const originPath = await getMainWorktreePath(ctx);

    // Prevent running on the main worktree itself
    // Use realPath to resolve symlinks (e.g., /tmp -> /private/tmp on macOS)
    const resolvedOrigin = await ctx.runtime.fs.realPath(originPath);
    const resolvedTarget = await ctx.runtime.fs.realPath(targetPath);
    const isMain = resolvedOrigin === resolvedTarget;
    if (isMain) {
      errorLog("Error: Not in a worktree. 'vibe copy' must be run from a worktree.", outputOpts);
      ctx.runtime.control.exit(1);
      return;
    }

    verboseLog(`Origin: ${originPath}`, outputOpts);
    verboseLog(`Target: ${targetPath}`, outputOpts);

    // Load config from the origin (main worktree)
    const config = await loadVibeConfig(originPath, ctx);

    const hasNoCopyConfig = !config?.copy?.files?.length && !config?.copy?.dirs?.length;
    if (hasNoCopyConfig) {
      verboseLog("No copy configuration found. Skipping.", outputOpts);
      return;
    }

    const copyService = getCopyService(ctx);

    const tracker = new ProgressTracker(
      {
        title: "Copying files to worktree",
      },
      ctx,
    );

    const shouldStartTracker = !dryRun;
    if (shouldStartTracker) {
      tracker.start();
    }

    await copyFiles(config.copy?.files ?? [], originPath, targetPath, tracker, copyService, dryRun);

    const hasDirs = (config.copy?.dirs?.length ?? 0) > 0;
    if (hasDirs) {
      const concurrency = resolveCopyConcurrency(config, ctx);
      await copyDirectories(
        config.copy?.dirs ?? [],
        originPath,
        targetPath,
        tracker,
        copyService,
        dryRun,
        concurrency,
        ctx,
      );
    }

    if (shouldStartTracker) {
      await tracker.finish();
    }

    if (!dryRun) {
      log("Copy complete.", outputOpts);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    errorLog(`Error: ${errorMessage}`, outputOpts);
    ctx.runtime.control.exit(1);
  }
}
