import { dirname, join } from "@std/path";
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
import { expandCopyPatterns } from "../utils/glob.ts";
import { ProgressTracker } from "../utils/progress.ts";

interface StartOptions {
  reuse?: boolean;
}

export async function startCommand(
  branchName: string,
  _options: StartOptions = {},
): Promise<void> {
  const isBranchNameEmpty = !branchName;
  if (isBranchNameEmpty) {
    console.error("Error: Branch name is required");
    Deno.exit(1);
  }

  try {
    const repoRoot = await getRepoRoot();
    const repoName = await getRepoName();
    const sanitizedBranch = sanitizeBranchName(branchName);
    const parentDir = dirname(repoRoot);
    const worktreePath = join(parentDir, `${repoName}-${sanitizedBranch}`);

    // Check if branch is already in use by another worktree
    const existingWorktreePath = await findWorktreeByBranch(branchName);
    const isBranchUsedInWorktree = existingWorktreePath !== null;
    if (isBranchUsedInWorktree) {
      const shouldNavigate = await confirm(
        `ブランチ '${branchName}' は既にworktree '${existingWorktreePath}' で使用中です。\n既存のworktreeに移動しますか? (Y/n)`,
      );

      if (shouldNavigate) {
        console.log(`cd '${existingWorktreePath}'`);
        Deno.exit(0);
      } else {
        console.error("キャンセルしました");
        Deno.exit(0);
      }
    }

    // Load config and verify trust before creating worktree
    const config: VibeConfig | undefined = await loadVibeConfig(repoRoot);

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
        // Start progress tracking
        const hasOperations = config !== undefined &&
          (config.hooks?.pre_start?.length ?? 0) +
                (config.copy?.files?.length ?? 0) +
                (config.hooks?.post_start?.length ?? 0) > 0;
        if (hasOperations) {
          tracker.start();
        }

        // Run pre_start hooks
        await runPreStartHooksIfNeeded(config, repoRoot, worktreePath, tracker);

        // Run config
        if (config !== undefined) {
          await runVibeConfig(config, repoRoot, worktreePath, tracker);
        }

        // Finish progress tracking
        if (hasOperations) {
          tracker.finish();
        }

        // Output cd command
        console.log(`cd '${worktreePath}'`);
        return;
      } else {
        // Different branch - offer to overwrite
        const choice = await select(
          `Directory '${worktreePath}' exists but contains different branch (${existingWorktree.branch}):`,
          ["上書き(削除して再作成)", "キャンセル"],
        );

        if (choice === 0) {
          await runGitCommand(["worktree", "remove", worktreePath, "--force"]);
        } else {
          console.error("キャンセルしました");
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

    // Start progress tracking
    const hasOperations = config !== undefined &&
      (config.hooks?.pre_start?.length ?? 0) +
            (config.copy?.files?.length ?? 0) +
            (config.hooks?.post_start?.length ?? 0) > 0;
    if (hasOperations) {
      tracker.start();
    }

    // Run pre_start hooks
    await runPreStartHooksIfNeeded(config, repoRoot, worktreePath, tracker);

    // Continue with existing process (post_start hooks are executed in runVibeConfig)
    if (config !== undefined) {
      await runVibeConfig(config, repoRoot, worktreePath, tracker);
    }

    // Finish progress tracking
    if (hasOperations) {
      tracker.finish();
    }

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
): Promise<void> {
  // Copy files from origin to worktree
  // Expand glob patterns to actual file paths
  const filesToCopy = await expandCopyPatterns(
    config.copy?.files ?? [],
    repoRoot,
  );

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

    // Ensure parent directory exists
    const destDir = dirname(dest);
    // Ignore errors if directory already exists
    await Deno.mkdir(destDir, { recursive: true }).catch(() => {});

    // Copy the file
    try {
      await Deno.copyFile(src, dest);
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

  // Run post_start hooks
  const postStartHooks = config.hooks?.post_start;
  if (postStartHooks !== undefined && postStartHooks.length > 0) {
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
