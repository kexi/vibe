import { dirname, join } from "@std/path";
import { parse } from "@std/toml";
import {
  getRepoName,
  getRepoRoot,
  runGitCommand,
  sanitizeBranchName,
} from "../utils/git.ts";
import { isTrusted } from "../utils/trust.ts";

interface VibeConfig {
  copy?: { files?: string[] };
  hooks?: { post_start?: string[] };
}

export async function startCommand(branchName: string): Promise<void> {
  const isBranchNameEmpty = !branchName;
  if (isBranchNameEmpty) {
    console.error("echo 'Error: Branch name is required'");
    Deno.exit(1);
  }

  try {
    const repoRoot = await getRepoRoot();
    const repoName = await getRepoName();
    const sanitizedBranch = sanitizeBranchName(branchName);
    const parentDir = dirname(repoRoot);
    const worktreePath = join(parentDir, `${repoName}-${sanitizedBranch}`);

    await runGitCommand(["worktree", "add", "-b", branchName, worktreePath]);

    const vibeTomlPath = join(repoRoot, ".vibe.toml");
    const vibeTomlExists = await fileExists(vibeTomlPath);
    if (vibeTomlExists) {
      const trusted = await isTrusted(vibeTomlPath);
      if (trusted) {
        const config = parse(
          await Deno.readTextFile(vibeTomlPath),
        ) as VibeConfig;
        await runVibeConfig(config, repoRoot, worktreePath);
      } else {
        console.error(
          "echo '.vibe.toml file found but not trusted. Run: vibe trust'",
        );
      }
    }

    console.log(`cd '${worktreePath}'`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`echo 'Error: ${errorMessage.replace(/'/g, "'\\''")}'`);
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
