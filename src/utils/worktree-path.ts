import { dirname, isAbsolute, join } from "@std/path";
import type { VibeConfig } from "../types/config.ts";
import type { VibeSettings } from "./settings.ts";

export interface WorktreePathContext {
  repoName: string;
  branchName: string;
  sanitizedBranch: string;
  repoRoot: string;
}

/**
 * Resolve the worktree path based on configuration
 * Priority: .vibe.local.toml > .vibe.toml > settings.json > default
 */
export async function resolveWorktreePath(
  config: VibeConfig | undefined,
  settings: VibeSettings,
  context: WorktreePathContext,
): Promise<string> {
  // Check if path_script is configured
  const pathScript = config?.worktree?.path_script ??
    settings.worktree?.path_script;

  const hasPathScript = pathScript !== undefined;
  if (hasPathScript) {
    return await executePathScript(pathScript, context);
  }

  // Default path: {parentDir}/{repoName}-{sanitizedBranch}
  const parentDir = dirname(context.repoRoot);
  return join(parentDir, `${context.repoName}-${context.sanitizedBranch}`);
}

async function executePathScript(
  scriptPath: string,
  context: WorktreePathContext,
): Promise<string> {
  // Expand ~ to home directory
  const home = Deno.env.get("HOME") ?? "";
  const expandedPath = scriptPath.replace(/^~/, home);

  // Resolve relative paths against repoRoot
  const resolvedPath = isAbsolute(expandedPath)
    ? expandedPath
    : join(context.repoRoot, expandedPath);

  // Check if script exists
  try {
    const stat = await Deno.stat(resolvedPath);
    const isNotFile = !stat.isFile;
    if (isNotFile) {
      throw new Error(`Worktree path script is not a file: ${resolvedPath}`);
    }
  } catch (error) {
    const isNotFoundError = error instanceof Deno.errors.NotFound;
    if (isNotFoundError) {
      throw new Error(`Worktree path script not found: ${resolvedPath}`);
    }
    throw error;
  }

  // Execute the script with environment variables
  const command = new Deno.Command(resolvedPath, {
    env: {
      ...Deno.env.toObject(),
      VIBE_REPO_NAME: context.repoName,
      VIBE_BRANCH_NAME: context.branchName,
      VIBE_SANITIZED_BRANCH: context.sanitizedBranch,
      VIBE_REPO_ROOT: context.repoRoot,
    },
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();

  const isScriptFailed = code !== 0;
  if (isScriptFailed) {
    const errorOutput = new TextDecoder().decode(stderr);
    throw new Error(`Worktree path script failed: ${errorOutput}`);
  }

  const path = new TextDecoder().decode(stdout).trim();

  // Validate that the path is absolute
  const isPathEmpty = !path;
  const isPathRelative = !isAbsolute(path);
  if (isPathEmpty || isPathRelative) {
    throw new Error(
      `Worktree path script must output an absolute path, got: ${path}`,
    );
  }

  return path;
}
