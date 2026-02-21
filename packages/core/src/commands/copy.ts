import { isAbsolute, resolve } from "node:path";
import { getMainWorktreePath, getRepoRoot } from "../utils/git.ts";
import { loadVibeConfig } from "../utils/config.ts";
import { ProgressTracker } from "../utils/progress.ts";
import { getCopyService } from "../utils/copy/index.ts";
import { copyFiles, copyDirectories, resolveCopyConcurrency } from "../utils/copy-runner.ts";
import { validatePath } from "../utils/copy/validation.ts";
import { errorLog, log, type OutputOptions, verboseLog } from "../utils/output.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";

/** Maximum stdin payload size in bytes (1 MB) to prevent resource exhaustion */
const MAX_STDIN_SIZE = 1024 * 1024;

interface CopyOptions extends OutputOptions {
  target?: string;
  dryRun?: boolean;
}

/**
 * Read target path from stdin JSON (Claude Code hook format).
 * Expects `{"cwd": "/path/to/worktree", ...}` on stdin.
 * Returns the cwd value, or undefined if stdin is empty or not valid JSON.
 */
async function readTargetFromStdin(ctx: AppContext): Promise<string | undefined> {
  const isInteractive = ctx.runtime.io.stdin.isTerminal();
  if (isInteractive) return undefined;

  try {
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(4096);
    let totalLength = 0;
    let bytesRead = await ctx.runtime.io.stdin.read(buf);
    while (bytesRead !== null && bytesRead > 0) {
      totalLength += bytesRead;
      // Guard against excessively large stdin payloads (max 1 MB)
      const exceedsMaxSize = totalLength > MAX_STDIN_SIZE;
      if (exceedsMaxSize) return undefined;

      chunks.push(buf.slice(0, bytesRead));
      bytesRead = await ctx.runtime.io.stdin.read(buf);
    }

    const hasNoInput = totalLength === 0;
    if (hasNoInput) return undefined;

    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const text = new TextDecoder().decode(combined).trim();
    const hasNoText = text.length === 0;
    if (hasNoText) return undefined;

    const json = JSON.parse(text);
    const cwd = json?.cwd;
    const isValidCwd = typeof cwd === "string" && cwd.length > 0;
    if (!isValidCwd) return undefined;

    // Security: validate the path from untrusted stdin input
    const isAbsolutePath = isAbsolute(cwd);
    if (!isAbsolutePath) return undefined;

    validatePath(cwd);

    return cwd;
  } catch {
    return undefined;
  }
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
    const isMain = resolve(originPath) === resolve(targetPath);
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
    const concurrency = resolveCopyConcurrency(config, ctx);

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
