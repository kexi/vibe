import { dirname, join } from "@std/path";
import {
  branchExists,
  findWorktreeByBranch,
  getRepoName,
  getRepoRoot,
  getWorktreeList,
  runGitCommand,
  sanitizeBranchName,
} from "../utils/git.ts";
import type { VibeConfig } from "../types/config.ts";
import { loadVibeConfig } from "../utils/config.ts";
import { runHooks } from "../utils/hooks.ts";
import { confirm, select } from "../utils/prompt.ts";
import { expandCopyPatterns } from "../utils/glob.ts";

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
        console.log("キャンセルしました");
        Deno.exit(0);
      }
    }

    // Load config and verify trust before creating worktree
    const config: VibeConfig | undefined = await loadVibeConfig(repoRoot);

    // Check if directory already exists
    try {
      await Deno.stat(worktreePath);

      const choice = await select(
        `ディレクトリ '${worktreePath}' は既に存在します:`,
        ["上書き(削除して再作成)", "再利用(既存を使用)", "キャンセル"],
      );

      const shouldOverwrite = choice === 0;
      if (shouldOverwrite) {
        // Safety check: verify the directory is actually a git worktree before deletion
        const worktrees = await getWorktreeList();
        const isGitWorktree = worktrees.some((w) => w.path === worktreePath);
        if (!isGitWorktree) {
          console.error(
            `Error: Directory '${worktreePath}' is not a git worktree. Cannot delete for safety.`,
          );
          Deno.exit(1);
        }
        await Deno.remove(worktreePath, { recursive: true });
      } else {
        const shouldReuse = choice === 1;
        if (shouldReuse) {
          // Reuse existing directory: skip git worktree add

          // Run pre_start hooks
          await runPreStartHooksIfNeeded(config, repoRoot, worktreePath);

          // Run config
          const hasConfig = config !== undefined;
          if (hasConfig) {
            await runVibeConfig(config, repoRoot, worktreePath);
          }

          // Launch shell or output cd command
          // @ts-ignore: Type inference issue in CI environment only
          const useShell = config?.shell === true;
          if (useShell) {
            const shellPath = Deno.env.get("SHELL") ?? "/bin/sh";
            const command = new Deno.Command(shellPath, {
              cwd: worktreePath,
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            });
            const process = command.spawn();
            const status = await process.status;
            Deno.exit(status.code);
          } else {
            console.log(`cd '${worktreePath}'`);
          }
          return;
        } else {
          // Cancel
          console.log("キャンセルしました");
          Deno.exit(0);
        }
      }
    } catch {
      // Directory doesn't exist, continue with normal flow
    }

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

    // Run pre_start hooks
    await runPreStartHooksIfNeeded(config, repoRoot, worktreePath);

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
  // Expand glob patterns to actual file paths
  const filesToCopy = await expandCopyPatterns(
    config.copy?.files ?? [],
    repoRoot,
  );

  for (const file of filesToCopy) {
    const src = join(repoRoot, file);
    const dest = join(worktreePath, file);

    // Ensure parent directory exists
    const destDir = dirname(dest);
    // Ignore errors if directory already exists
    await Deno.mkdir(destDir, { recursive: true }).catch(() => {});

    // Copy the file
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

async function runPreStartHooksIfNeeded(
  config: VibeConfig | undefined,
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  const preStartHooks = config?.hooks?.pre_start;
  if (preStartHooks !== undefined) {
    await runHooks(preStartHooks, repoRoot, {
      worktreePath,
      originPath: repoRoot,
    });
  }
}
