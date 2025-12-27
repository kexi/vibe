import { dirname, join } from "@std/path";
import {
  getRepoRoot,
  getRepoName,
  runGitCommand,
  sanitizeBranchName,
} from "../utils/git.ts";
import { isTrusted } from "../utils/trust.ts";

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

    const vibeFilePath = join(repoRoot, ".vibe");
    const vibeFileExists = await fileExists(vibeFilePath);
    if (vibeFileExists) {
      const trusted = await isTrusted(vibeFilePath);
      if (trusted) {
        const runVibeCommand = new Deno.Command("zsh", {
          args: [vibeFilePath],
          cwd: worktreePath,
          stdout: "inherit",
          stderr: "inherit",
        });
        await runVibeCommand.output();
      } else {
        console.error(`echo '.vibe file found but not trusted. Run: vibe trust'`);
      }
    }

    console.log(`cd '${worktreePath}'`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`echo 'Error: ${errorMessage.replace(/'/g, "'\\''")}'`);
    Deno.exit(1);
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
