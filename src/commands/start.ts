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
import { log, type OutputOptions, verboseLog } from "../utils/output.ts";

interface StartOptions extends OutputOptions {
  reuse?: boolean;
  noHooks?: boolean;
  noCopy?: boolean;
  dryRun?: boolean;
}

interface ConfigAndHooksOptions extends OutputOptions {
  skipHooks?: boolean;
  skipCopy?: boolean;
  dryRun?: boolean;
}

function logDryRun(message: string): void {
  console.error(`[dry-run] ${message}`);
}

async function runConfigAndHooks(
  config: VibeConfig | undefined,
  repoRoot: string,
  worktreePath: string,
  tracker: ProgressTracker,
  options: ConfigAndHooksOptions = {},
): Promise<void> {
  const { skipHooks = false, skipCopy = false, dryRun = false } = options;

  const hooksCount = skipHooks ? 0 : (config?.hooks?.pre_start?.length ?? 0) +
    (config?.hooks?.post_start?.length ?? 0);
  const copyCount = skipCopy
    ? 0
    : (config?.copy?.files?.length ?? 0) + (config?.copy?.dirs?.length ?? 0);
  const hasOperations = config !== undefined && hooksCount + copyCount > 0;

  // Don't start tracker in dry-run mode
  const shouldStartTracker = !dryRun && hasOperations;
  if (shouldStartTracker) {
    tracker.start();
  }

  const shouldRunPreStartHooks = !skipHooks;
  if (shouldRunPreStartHooks) {
    await runPreStartHooksIfNeeded(config, repoRoot, worktreePath, tracker, dryRun);
  }

  if (config !== undefined) {
    await runVibeConfig(config, repoRoot, worktreePath, tracker, {
      skipHooks,
      skipCopy,
      dryRun,
    });
  }

  if (shouldStartTracker) {
    tracker.finish();
  }
}

export async function startCommand(
  branchName: string,
  options: StartOptions = {},
): Promise<void> {
  const { noHooks = false, noCopy = false, dryRun = false, verbose = false, quiet = false } =
    options;
  const outputOpts: OutputOptions = { verbose, quiet };
  const isBranchNameEmpty = !branchName;
  if (isBranchNameEmpty) {
    console.error("Error: Branch name is required");
    Deno.exit(1);
  }

  try {
    const repoRoot = await getRepoRoot();
    const repoName = await getRepoName();
    const sanitizedBranch = sanitizeBranchName(branchName);

    verboseLog(`Repository root: ${repoRoot}`, outputOpts);
    verboseLog(`Repository name: ${repoName}`, outputOpts);
    verboseLog(`Sanitized branch: ${sanitizedBranch}`, outputOpts);

    // Check if branch is already in use by another worktree
    const existingWorktreePath = await findWorktreeByBranch(branchName);
    const isBranchUsedInWorktree = existingWorktreePath !== null;
    if (isBranchUsedInWorktree) {
      if (dryRun) {
        logDryRun(`Branch '${branchName}' is already used in worktree '${existingWorktreePath}'`);
        logDryRun(`Would navigate to: ${existingWorktreePath}`);
        return;
      }
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

    verboseLog(`Resolved worktree path: ${worktreePath}`, outputOpts);

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
        if (dryRun) {
          logDryRun(`Worktree already exists at '${worktreePath}'`);
          logDryRun("Would run hooks and config, then navigate to worktree");
          await runConfigAndHooks(config, repoRoot, worktreePath, tracker, {
            skipHooks: noHooks,
            skipCopy: noCopy,
            dryRun,
            ...outputOpts,
          });
          logDryRun(`Would change directory to: ${worktreePath}`);
          return;
        }
        log(`Note: Worktree already exists at '${worktreePath}'`, outputOpts);

        // Run hooks and config in case they changed
        await runConfigAndHooks(config, repoRoot, worktreePath, tracker, {
          skipHooks: noHooks,
          skipCopy: noCopy,
          ...outputOpts,
        });

        // Output cd command
        console.log(`cd '${worktreePath}'`);
        return;
      } else {
        // Different branch - offer to overwrite
        if (dryRun) {
          logDryRun(
            `Directory '${worktreePath}' already exists(branch: ${existingWorktree.branch})`,
          );
          logDryRun("Would prompt to Overwrite/Reuse/Cancel");
          return;
        }
        const choice = await select(
          `Directory '${worktreePath}' already exists(branch: ${existingWorktree.branch}): `,
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
            ...outputOpts,
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
    const gitCommand = branchAlreadyExists
      ? `git worktree add '${worktreePath}' ${branchName}`
      : `git worktree add -b ${branchName} '${worktreePath}'`;

    if (dryRun) {
      logDryRun(`Would run: ${gitCommand}`);
      logDryRun(`Worktree path: ${worktreePath}`);
    } else {
      if (branchAlreadyExists) {
        verboseLog(`Running: git worktree add '${worktreePath}' ${branchName}`, outputOpts);
        await runGitCommand(["worktree", "add", worktreePath, branchName]);
      } else {
        verboseLog(`Running: git worktree add -b ${branchName} '${worktreePath}'`, outputOpts);
        await runGitCommand(["worktree", "add", "-b", branchName, worktreePath]);
      }
    }

    // Run hooks and config
    await runConfigAndHooks(config, repoRoot, worktreePath, tracker, {
      skipHooks: noHooks,
      skipCopy: noCopy,
      dryRun,
      ...outputOpts,
    });

    if (dryRun) {
      logDryRun(`Would change directory to: ${worktreePath}`);
    } else {
      console.log(`cd '${worktreePath}'`);
    }
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
  const { skipHooks = false, skipCopy = false, dryRun = false } = options;
  const errors: string[] = [];

  // Get the copy service (automatically selects the best strategy)
  const copyService = getCopyService();

  // Copy files from origin to worktree
  // Expand glob patterns to actual file paths
  const shouldCopyFiles = !skipCopy;
  const filesToCopy = shouldCopyFiles
    ? await expandCopyPatterns(config.copy?.files ?? [], repoRoot, options)
    : [];

  const shouldCopyFilesConfigured = (config.copy?.files?.length ?? 0) > 0;
  if (shouldCopyFilesConfigured && filesToCopy.length === 0 && !skipCopy) {
    errors.push("Configuration specified copy.files but no files were found");
  }

  // Always log count of files to copy for debugging
  if (filesToCopy.length > 0) {
    verboseLog(`Found ${filesToCopy.length} files to copy`, options);
  }

  // Handle dry-run for file copying
  if (dryRun && filesToCopy.length > 0) {
    logDryRun("Would copy files:");
    for (const file of filesToCopy) {
      logDryRun(`  - ${file}`);
    }
  } else {
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
        errors.push(`Failed to copy file '${file}': ${errorMessage}`);
      }
    }
  }

  // Copy directories from origin to worktree
  const shouldCopyDirs = !skipCopy;
  const directoriesToCopy = shouldCopyDirs
    ? await expandDirectoryPatterns(config.copy?.dirs ?? [], repoRoot, options)
    : [];

  const shouldCopyDirsConfigured = (config.copy?.dirs?.length ?? 0) > 0;
  if (shouldCopyDirsConfigured && directoriesToCopy.length === 0 && !skipCopy) {
    errors.push("Configuration specified copy.dirs but no directories were found");
  }

  // Always log count of directories to copy for debugging
  if (directoriesToCopy.length > 0) {
    verboseLog(`Found ${directoriesToCopy.length} directories to copy`, options);
  }

  // Handle dry-run for directory copying
  if (dryRun && directoriesToCopy.length > 0) {
    logDryRun("Would copy directories:");
    for (const dir of directoriesToCopy) {
      logDryRun(`  - ${dir}`);
    }
  } else {
    // Add directory copying phase if there are directories to copy
    let dirCopyPhaseId: string | undefined;
    const dirCopyTaskIds: string[] = [];
    const hasDirectoriesToCopy = directoriesToCopy.length > 0;
    if (tracker && hasDirectoriesToCopy) {
      // Get strategy name to show in progress
      const dirStrategy = await copyService.getDirectoryStrategy();
      const strategyName = dirStrategy.name;
      dirCopyPhaseId = tracker.addPhase(`Copying directories(${strategyName})`);
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
        errors.push(`Failed to copy directory '${dir}': ${errorMessage}`);
      }
    });

    await Promise.all(directoryCopyPromises);
  }

  if (errors.length > 0) {
    throw new Error(`Copy operation failed with ${errors.length} errors: \n${errors.join("\n")} `);
  }

  // Run post_start hooks
  const shouldRunPostStartHooks = !skipHooks;
  const postStartHooks = config.hooks?.post_start;
  const hasPostStartHooks = postStartHooks !== undefined && postStartHooks.length > 0;

  if (dryRun && shouldRunPostStartHooks && hasPostStartHooks) {
    logDryRun("Would run post-start hooks:");
    for (const hook of postStartHooks) {
      logDryRun(`  - ${hook} `);
    }
  } else if (shouldRunPostStartHooks && hasPostStartHooks) {
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
  dryRun: boolean = false,
): Promise<void> {
  const preStartHooks = config?.hooks?.pre_start;
  const hasPreStartHooks = preStartHooks !== undefined && preStartHooks.length > 0;

  if (!hasPreStartHooks) {
    return;
  }

  if (dryRun) {
    logDryRun("Would run pre-start hooks:");
    for (const hook of preStartHooks) {
      logDryRun(`  - ${hook} `);
    }
    return;
  }

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
