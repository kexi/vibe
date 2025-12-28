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

    // pre_startフックの実行
    const hasPreStartHooks = config?.hooks?.pre_start !== undefined;
    if (hasPreStartHooks) {
      await runHooks(config!.hooks!.pre_start!, repoRoot, { repoRoot, worktreePath });
    }

    // 既存の処理は続行される（runVibeConfigでpost_startフックを実行）
    const hasConfig = config !== undefined;
    if (hasConfig) {
      await runVibeConfig(config, repoRoot, worktreePath);
    }

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
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    Deno.exit(1);
  }
}

async function runHooks(
  commands: string[],
  cwd: string,
  env: { repoRoot: string; worktreePath: string },
): Promise<void> {
  const hookEnv = {
    ...Deno.env.toObject(),
    VIBE_WORKTREE_PATH: env.worktreePath,
    VIBE_ORIGIN_PATH: env.repoRoot,
  };

  for (const cmd of commands) {
    const proc = new Deno.Command("sh", {
      args: ["-c", cmd],
      cwd,
      env: hookEnv,
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.output();
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
    await Deno.copyFile(src, dest).catch(() => {});
  }

  // Run post_start hooks
  const env = {
    ...Deno.env.toObject(),
    VIBE_WORKTREE_PATH: worktreePath,
    VIBE_ORIGIN_PATH: repoRoot,
  };
  for (const cmd of config.hooks?.post_start ?? []) {
    const proc = new Deno.Command("sh", {
      args: ["-c", cmd],
      cwd: worktreePath,
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.output();
  }
}
