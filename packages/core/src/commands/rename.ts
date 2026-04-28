import { basename } from "node:path";
import { type AppContext, getGlobalContext } from "../context/index.ts";
import { loadVibeConfig } from "../utils/config.ts";
import {
  branchExists,
  findWorktreeByBranch,
  getMainWorktreePath,
  getWorktreeByPath,
  isMainWorktree,
  sanitizeBranchName,
} from "../utils/git.ts";
import { resolveWorktreePath } from "../utils/worktree-path.ts";
import { loadUserSettings } from "../utils/settings.ts";
import { updateMruBranch } from "../utils/mru.ts";
import {
  errorLog,
  log,
  logDryRun,
  type OutputOptions,
  successLog,
  verboseLog,
} from "../utils/output.ts";
import { formatCdCommand } from "../utils/shell.ts";
import {
  getBranchUpstream,
  getMoveWorktreeCommand,
  getRenameBranchCommand,
  moveWorktree,
  renameBranch,
} from "../services/worktree/index.ts";

export interface RenameOptions extends OutputOptions {
  dryRun?: boolean;
}

export async function renameCommand(
  newName: string,
  options: RenameOptions = {},
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const { runtime } = ctx;
  const { dryRun = false, verbose = false, quiet = false } = options;
  const outputOpts: OutputOptions = { verbose, quiet };

  const trimmedNewName = (newName ?? "").trim();
  const isNewNameEmpty = trimmedNewName === "";
  if (isNewNameEmpty) {
    errorLog("Error: New branch name is required", outputOpts);
    runtime.control.exit(1);
    return;
  }

  try {
    const cwd = runtime.control.cwd();
    let realCwd: string;
    try {
      realCwd = await runtime.fs.realPath(cwd);
    } catch {
      realCwd = cwd;
    }

    const currentWorktree = await getWorktreeByPath(realCwd, ctx);
    if (currentWorktree === null) {
      errorLog("Error: Not in a vibe worktree", outputOpts);
      runtime.control.exit(1);
      return;
    }

    const isMain = await isMainWorktree(ctx);
    if (isMain) {
      errorLog("Error: Cannot rename main worktree", outputOpts);
      runtime.control.exit(1);
      return;
    }

    const oldName = currentWorktree.branch;
    const oldPath = currentWorktree.path;

    const sanitizedNew = sanitizeBranchName(trimmedNewName);
    if (sanitizedNew !== trimmedNewName) {
      verboseLog(`Sanitized branch name: ${trimmedNewName} -> ${sanitizedNew}`, outputOpts);
    }

    const isSameName = sanitizedNew === oldName;
    if (isSameName) {
      log(`Already named '${oldName}'`, outputOpts);
      console.log(formatCdCommand(oldPath));
      return;
    }

    const upstream = await getBranchUpstream(oldName, ctx);
    const isPushed = typeof upstream === "object" && "remote" in upstream;
    if (isPushed) {
      const remote = upstream.remote;
      errorLog(`Error: branch '${oldName}' is pushed to '${remote}'`, outputOpts);
      errorLog(
        "vibe rename does not handle pushed branches to avoid remote divergence.",
        outputOpts,
      );
      errorLog("To rename manually:", outputOpts);
      errorLog(`  git branch -m ${oldName} ${sanitizedNew}`, outputOpts);
      errorLog(`  git push ${remote} -u ${sanitizedNew}`, outputOpts);
      errorLog(`  git push ${remote} --delete ${oldName}`, outputOpts);
      errorLog("  # then move the worktree directory yourself", outputOpts);
      runtime.control.exit(1);
      return;
    }

    const [targetBranchUsed, targetWorktreePath] = await Promise.all([
      branchExists(sanitizedNew, ctx),
      findWorktreeByBranch(sanitizedNew, ctx),
    ]);
    if (targetBranchUsed) {
      errorLog(`Error: branch '${sanitizedNew}' already exists`, outputOpts);
      runtime.control.exit(1);
      return;
    }
    if (targetWorktreePath !== null) {
      errorLog(
        `Error: a worktree using '${sanitizedNew}' already exists at ${targetWorktreePath}`,
        outputOpts,
      );
      runtime.control.exit(1);
      return;
    }

    // Resolve the path from the main worktree so the new worktree is named
    // after the repository (e.g. `vibe-<branch>`) and not after whichever
    // secondary worktree (e.g. a scratch) we happen to be standing in.
    const mainWorktreePath = await getMainWorktreePath(ctx);
    const repoName = basename(mainWorktreePath);
    const settings = await loadUserSettings(ctx);
    const config = await loadVibeConfig(mainWorktreePath, ctx);

    const newPath = await resolveWorktreePath(
      config,
      settings,
      {
        repoName,
        branchName: sanitizedNew,
        sanitizedBranch: sanitizeBranchName(sanitizedNew),
        repoRoot: mainWorktreePath,
      },
      ctx,
    );

    const isPathUnchanged = newPath === oldPath;
    if (isPathUnchanged) {
      verboseLog(`Worktree directory unchanged: ${oldPath}`, outputOpts);
    }

    if (dryRun) {
      if (!isPathUnchanged) {
        logDryRun(`Would run: ${getMoveWorktreeCommand(oldPath, newPath)}`);
      }
      logDryRun(`Would run: ${getRenameBranchCommand(oldName, sanitizedNew)}`);
      logDryRun(`Would change directory to: ${newPath}`);
      return;
    }

    if (!isPathUnchanged) {
      try {
        await moveWorktree(oldPath, newPath, ctx);
        // The process was launched from oldPath; that directory no longer
        // exists after the move. Subsequent git subprocesses inherit cwd
        // and would fail with ENOENT on spawn. Move into the new path so
        // further commands have a valid working directory.
        runtime.control.chdir(newPath);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errorLog(`Error: failed to move worktree directory: ${msg}`, outputOpts);
        runtime.control.exit(1);
        return;
      }
    }

    try {
      await renameBranch(oldName, sanitizedNew, ctx);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errorLog(`Error: failed to rename branch: ${msg}`, outputOpts);
      if (!isPathUnchanged) {
        try {
          await moveWorktree(newPath, oldPath, ctx);
          runtime.control.chdir(oldPath);
          errorLog("Worktree directory rolled back to original path.", outputOpts);
        } catch (rbErr) {
          const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
          errorLog(`Error: rollback failed: ${rbMsg}`, outputOpts);
          errorLog(`Manual recovery: git worktree move '${newPath}' '${oldPath}'`, outputOpts);
        }
      }
      runtime.control.exit(1);
      return;
    }

    try {
      await updateMruBranch(oldPath, newPath, sanitizedNew, ctx);
    } catch {
      // MRU update failure should not affect rename
    }

    successLog(`Renamed ${oldName} -> ${sanitizedNew}`, outputOpts);
    if (!isPathUnchanged) {
      log(`Directory: ${oldPath} -> ${newPath}`, outputOpts);
    }
    console.log(formatCdCommand(newPath));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errorLog(`Error: ${msg}`, outputOpts);
    runtime.control.exit(1);
  }
}
