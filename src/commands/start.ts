import { join } from "@std/path";
import {
  branchExists,
  findWorktreeByBranch,
  getRepoName,
  getRepoRoot,
  getWorktreeByPath,
  runGitCommand,
  sanitizeBranchName,
} from "../utils/git.ts";
import type { VibeConfig } from "../types/config.ts";
import { loadVibeConfig } from "../utils/config.ts";
import { type HookTrackerInfo, runHooks } from "../utils/hooks.ts";
import { confirm, select } from "../utils/prompt.ts";
import { expandCopyPatterns, expandDirectoryPatterns } from "../utils/glob.ts";
import { ProgressTracker } from "../utils/progress.ts";
import { getCopyService } from "../utils/copy/index.ts";
import { loadUserSettings } from "../utils/settings.ts";
import { resolveWorktreePath } from "../utils/worktree-path.ts";

interface StartOptions {
  reuse?: boolean;
  noHooks?: boolean;
  noCopy?: boolean;
}

interface ConfigAndHooksOptions {
  skipHooks?: boolean;
  skipCopy?: boolean;
}

async function runConfigAndHooks(
  config: VibeConfig | undefined,
  repoRoot: string,
  worktreePath: string,
  tracker: ProgressTracker,
  options: ConfigAndHooksOptions = {},
): Promise<void> {
  const { skipHooks = false, skipCopy = false } = options;

  const hooksCount = skipHooks ? 0 : (config?.hooks?.pre_start?.length ?? 0) +
    (config?.hooks?.post_start?.length ?? 0);
  const copyCount = skipCopy
    ? 0
    : (config?.copy?.files?.length ?? 0) + (config?.copy?.dirs?.length ?? 0);
  const hasOperations = config !== undefined && hooksCount + copyCount > 0;

  if (hasOperations) {
    tracker.start();
  }

  const shouldRunPreStartHooks = !skipHooks;
  if (shouldRunPreStartHooks) {
    await runPreStartHooksIfNeeded(config, repoRoot, worktreePath, tracker);
  }

  if (config !== undefined) {
    await runVibeConfig(config, repoRoot, worktreePath, tracker, {
      skipHooks,
      skipCopy,
    });
  }

  if (hasOperations) {
    tracker.finish();
  }
}

export async function startCommand(
  branchName: string,
  options: StartOptions = {},
): Promise<void> {
  const { noHooks = false, noCopy = false } = options;
  const isBranchNameEmpty = !branchName;
  if (isBranchNameEmpty) {
    console.error("Error: Branch name is required");
    Deno.exit(1);
  }

  try {
    const repoRoot = await getRepoRoot();
    const repoName = await getRepoName();
    const sanitizedBranch = sanitizeBranchName(branchName);

    // Check if branch is already in use by another worktree
    const existingWorktreePath = await findWorktreeByBranch(branchName);
    const isBranchUsedInWorktree = existingWorktreePath !== null;
    if (isBranchUsedInWorktree) {
      const shouldNavigate = await confirm(
        `Branch '${branchName}' is already used in worktree '${existingWorktreePath}'.\nNavigate to the existing worktree? (Y/n)`,
      );

      if (shouldNavigate) {
        console.log(`cd '${existingWorktreePath}'`);
        Deno.exit(0);
      } else {
        console.error("Cancelled");
        Deno.exit(0);
      }
    }

    // Load settings and config before determining worktree path
    const settings = await loadUserSettings();
    const config: VibeConfig | undefined = await loadVibeConfig(repoRoot);

    // Resolve worktree path (may use external script)
    const worktreePath = await resolveWorktreePath(config, settings, {
      repoName,
      branchName,
      sanitizedBranch,
      repoRoot,
    });

    // Create progress tracker
    const tracker = new ProgressTracker({
      title: `Setting up worktree ${branchName}`,
    });

    // Check if worktree already exists at the target path
    const existingWorktree = await getWorktreeByPath(worktreePath);

    if (existingWorktree !== null) {
      // Worktree already exists
      if (existingWorktree.branch === branchName) {
        // Same branch - idempotent re-entry
        console.error(`Note: Worktree already exists at '${worktreePath}'`);

        // Run hooks and config in case they changed
        await runConfigAndHooks(config, repoRoot, worktreePath, tracker, {
          skipHooks: noHooks,
          skipCopy: noCopy,
        });

        // Output cd command
        console.log(`cd '${worktreePath}'`);
        return;
      } else {
        // Different branch - offer to overwrite
        const choice = await select(
          `Directory '${worktreePath}' already exists (branch: ${existingWorktree.branch}):`,
          ["Overwrite (remove and recreate)", "Reuse (use existing)", "Cancel"],
        );

        if (choice === 0) {
          // Overwrite: remove existing worktree
          await runGitCommand(["worktree", "remove", worktreePath, "--force"]);
        } else if (choice === 1) {
          // Reuse: skip git worktree creation, run hooks/config, and output cd
          await runConfigAndHooks(config, repoRoot, worktreePath, tracker, {
            skipHooks: noHooks,
            skipCopy: noCopy,
          });

          // Output cd command
          console.log(`cd '${worktreePath}'`);
          return;
        } else {
          // Cancel
          console.error("Cancelled");
          Deno.exit(0);
        }
      }
    }

    // Path doesn't exist or was overwritten - create worktree
    const branchAlreadyExists = await branchExists(branchName);
    if (branchAlreadyExists) {
      // No --reuse flag required anymore
      await runGitCommand(["worktree", "add", worktreePath, branchName]);
    } else {
      await runGitCommand(["worktree", "add", "-b", branchName, worktreePath]);
    }

    // Run hooks and config
    await runConfigAndHooks(config, repoRoot, worktreePath, tracker, {
      skipHooks: noHooks,
      skipCopy: noCopy,
    });

    console.log(`cd '${worktreePath}'`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    Deno.exit(1);
  }
}

async function runVibeConfig(
  config: VibeConfig,
  repoRoot: string,
  worktreePath: string,
  tracker?: ProgressTracker,
  options: ConfigAndHooksOptions = {},
): Promise<void> {
  const { skipHooks = false, skipCopy = false } = options;

  // Get the copy service (automatically selects the best strategy)
  const copyService = getCopyService();

  // Copy files from origin to worktree
  // Expand glob patterns to actual file paths
  const shouldCopyFiles = !skipCopy;
  const filesToCopy = shouldCopyFiles
    ? await expandCopyPatterns(config.copy?.files ?? [], repoRoot)
    : [];

  // Add file copying phase if there are files to copy
  let copyPhaseId: string | undefined;
  const copyTaskIds: string[] = [];
  if (tracker && filesToCopy.length > 0) {
    copyPhaseId = tracker.addPhase("Copying files");
    for (const file of filesToCopy) {
      const taskId = tracker.addTask(copyPhaseId, file);
      copyTaskIds.push(taskId);
    }
  }

  for (let i = 0; i < filesToCopy.length; i++) {
    const file = filesToCopy[i];
    const src = join(repoRoot, file);
    const dest = join(worktreePath, file);

    // Update progress: start task
    if (tracker && copyTaskIds.length > 0) {
      tracker.startTask(copyTaskIds[i]);
    }

    // Copy the file using CopyService
    try {
      await copyService.copyFile(src, dest);
      // Update progress: complete task
      if (tracker && copyTaskIds.length > 0) {
        tracker.completeTask(copyTaskIds[i]);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Update progress: fail task
      if (tracker && copyTaskIds.length > 0) {
        tracker.failTask(copyTaskIds[i], errorMessage);
      }
      console.warn(`Warning: Failed to copy ${file}: ${errorMessage}`);
    }
  }

  // Copy directories from origin to worktree
  const shouldCopyDirs = !skipCopy;
  const directoriesToCopy = shouldCopyDirs
    ? await expandDirectoryPatterns(config.copy?.dirs ?? [], repoRoot)
    : [];

  // Add directory copying phase if there are directories to copy
  let dirCopyPhaseId: string | undefined;
  const dirCopyTaskIds: string[] = [];
  const hasDirectoriesToCopy = directoriesToCopy.length > 0;
  if (tracker && hasDirectoriesToCopy) {
    // Get strategy name to show in progress
    const dirStrategy = await copyService.getDirectoryStrategy();
    const strategyName = dirStrategy.name;
    dirCopyPhaseId = tracker.addPhase(`Copying directories (${strategyName})`);
    for (const dir of directoriesToCopy) {
      const taskId = tracker.addTask(dirCopyPhaseId, dir);
      dirCopyTaskIds.push(taskId);
    }
  }

  // Copy directories in parallel for better performance with clonefile
  const directoryCopyPromises = directoriesToCopy.map(async (dir, i) => {
    const src = join(repoRoot, dir);
    const dest = join(worktreePath, dir);

    // Update progress: start task
    if (tracker && dirCopyTaskIds.length > 0) {
      tracker.startTask(dirCopyTaskIds[i]);
    }

    // Copy directory using CopyService
    try {
      await copyService.copyDirectory(src, dest);
      // Update progress: complete task
      if (tracker && dirCopyTaskIds.length > 0) {
        tracker.completeTask(dirCopyTaskIds[i]);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Update progress: fail task
      if (tracker && dirCopyTaskIds.length > 0) {
        tracker.failTask(dirCopyTaskIds[i], errorMessage);
      }
      console.warn(`Warning: Failed to copy directory ${dir}: ${errorMessage}`);
    }
  });

  await Promise.all(directoryCopyPromises);

  // Run post_start hooks
  const shouldRunPostStartHooks = !skipHooks;
  const postStartHooks = config.hooks?.post_start;
  if (shouldRunPostStartHooks && postStartHooks !== undefined && postStartHooks.length > 0) {
    let trackerInfo: HookTrackerInfo | undefined;
    if (tracker) {
      const phaseId = tracker.addPhase("Post-start hooks");
      const taskIds = postStartHooks.map((hook) => tracker.addTask(phaseId, hook));
      trackerInfo = { tracker, taskIds };
    }

    await runHooks(postStartHooks, worktreePath, {
      worktreePath,
      originPath: repoRoot,
    }, trackerInfo);
  }
}

async function runPreStartHooksIfNeeded(
  config: VibeConfig | undefined,
  repoRoot: string,
  worktreePath: string,
  tracker?: ProgressTracker,
): Promise<void> {
  const preStartHooks = config?.hooks?.pre_start;
  if (preStartHooks !== undefined && preStartHooks.length > 0) {
    let trackerInfo: HookTrackerInfo | undefined;
    if (tracker) {
      const phaseId = tracker.addPhase("Pre-start hooks");
      const taskIds = preStartHooks.map((hook) => tracker.addTask(phaseId, hook));
      trackerInfo = { tracker, taskIds };
    }

    await runHooks(preStartHooks, repoRoot, {
      worktreePath,
      originPath: repoRoot,
    }, trackerInfo);
  }
}
