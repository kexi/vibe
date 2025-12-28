import { dirname, join } from "@std/path";
import {
  branchExists,
  getRepoName,
  getRepoRoot,
  runGitCommand,
  sanitizeBranchName,
} from "../utils/git.ts";
import type { VibeConfig } from "../types/config.ts";
import { loadVibeConfig } from "../utils/config.ts";
import { runHooks } from "../utils/hooks.ts";

interface StartOptions {
  reuse?: boolean;
}

export async function startCommand(
  branchName: string,
  options: StartOptions = {},
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

    const branchAlreadyExists = await branchExists(branchName);
    if (branchAlreadyExists) {
      if (!options.reuse) {
        console.error(
          `Error: Branch '${branchName}' already exists. Use --reuse to use existing branch.`,
        );
        Deno.exit(1);
      }
      await runGitCommand(["worktree", "add", worktreePath, branchName]);
    } else {
      await runGitCommand(["worktree", "add", "-b", branchName, worktreePath]);
    }

    const config = await loadVibeConfig(repoRoot);

    // Run pre_start hooks
    const preStartHooks = config?.hooks?.pre_start;
    if (preStartHooks !== undefined) {
      await runHooks(preStartHooks, repoRoot, {
        worktreePath,
        originPath: repoRoot,
      });
    }

    // Continue with existing process (post_start hooks are executed in runVibeConfig)
    if (config !== undefined) {
      await runVibeConfig(config, repoRoot, worktreePath);
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
): Promise<void> {
  // Copy files from origin to worktree
  for (const file of config.copy?.files ?? []) {
    const src = join(repoRoot, file);
    const dest = join(worktreePath, file);
    await Deno.copyFile(src, dest).catch((err) => {
      console.error(`Warning: Failed to copy ${file}: ${err.message}`);
    });
  }

  // Run post_start hooks
  const postStartHooks = config.hooks?.post_start;
  if (postStartHooks !== undefined) {
    await runHooks(postStartHooks, worktreePath, {
      worktreePath,
      originPath: repoRoot,
    });
  }
}
