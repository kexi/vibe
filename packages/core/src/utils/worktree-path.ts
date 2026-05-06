import { dirname, isAbsolute, join } from "node:path";
import type { VibeConfig } from "../types/config.ts";
import type { VibeSettings } from "./settings.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";
import {
  assertNoControlChars,
  assertOutputHasNoControlChars,
  buildShellMetacharWarning,
  buildWarningKey,
  findShellMetachars,
} from "./worktree-path-validation.ts";
import { warnLog } from "./output.ts";

export interface WorktreePathContext {
  repoName: string;
  branchName: string;
  sanitizedBranch: string;
  repoRoot: string;
}

/**
 * Process-scoped dedup of shell-metacharacter warnings. The same
 * `(field, metachars)` combination is warned at most once per process.
 */
const emittedWarnings = new Set<string>();

/** Test-only: clear the dedup cache so each test sees a fresh state. */
export function __resetEmittedWarningsForTest(): void {
  emittedWarnings.clear();
}

/**
 * Resolve the worktree path based on configuration
 * Priority: .vibe.local.toml > .vibe.toml > settings.json > default
 */
export async function resolveWorktreePath(
  config: VibeConfig | undefined,
  settings: VibeSettings,
  context: WorktreePathContext,
  ctx: AppContext = getGlobalContext(),
): Promise<string> {
  // Check if path_script is configured
  const pathScript = config?.worktree?.path_script ?? settings.worktree?.path_script;

  const hasPathScript = pathScript !== undefined;
  if (hasPathScript) {
    return await executePathScript(pathScript, context, ctx);
  }

  // Default path: {parentDir}/{repoName}-{sanitizedBranch}
  const parentDir = dirname(context.repoRoot);
  return join(parentDir, `${context.repoName}-${context.sanitizedBranch}`);
}

/**
 * Build the env passed to `path_script`. Centralising this here ensures any new
 * VIBE_* field automatically passes through the validation pipeline (Layer 1
 * reject, Layer 2 warn) — adding a field elsewhere would require touching this
 * one function.
 */
function buildPathScriptEnv(
  context: WorktreePathContext,
  parentEnv: Record<string, string>,
): Record<string, string> {
  // Layer 1: hard-reject control characters in any field. Newlines/NULs in env
  // values are how attackers smuggle extra arguments or commands.
  assertNoControlChars("VIBE_REPO_NAME", context.repoName);
  assertNoControlChars("VIBE_BRANCH_NAME", context.branchName);
  assertNoControlChars("VIBE_SANITIZED_BRANCH", context.sanitizedBranch);
  assertNoControlChars("VIBE_REPO_ROOT", context.repoRoot);

  // Layer 2: warn (don't block) on shell metacharacters in branch/repo fields.
  // repoRoot is excluded because legitimate paths often include `$` or `\` and
  // warning on those would just be noise.
  warnIfShellMetachars("VIBE_REPO_NAME", context.repoName);
  warnIfShellMetachars("VIBE_BRANCH_NAME", context.branchName);
  warnIfShellMetachars("VIBE_SANITIZED_BRANCH", context.sanitizedBranch);

  return {
    ...parentEnv,
    VIBE_REPO_NAME: context.repoName,
    VIBE_BRANCH_NAME: context.branchName,
    VIBE_SANITIZED_BRANCH: context.sanitizedBranch,
    VIBE_REPO_ROOT: context.repoRoot,
  };
}

function warnIfShellMetachars(fieldName: string, value: string): void {
  const metachars = findShellMetachars(value);
  const isClean = metachars.length === 0;
  if (isClean) {
    return;
  }

  const key = buildWarningKey(fieldName, metachars);
  const isDuplicate = emittedWarnings.has(key);
  if (isDuplicate) {
    return;
  }
  emittedWarnings.add(key);

  warnLog(buildShellMetacharWarning(fieldName, metachars));
}

async function executePathScript(
  scriptPath: string,
  context: WorktreePathContext,
  ctx: AppContext,
): Promise<string> {
  const { runtime } = ctx;

  // Validate VIBE_REPO_ROOT before any path manipulation: Node's `path.join()`
  // itself throws on NUL bytes, masking our own clearer error message. Reject
  // early so the user sees the actionable hint. The remaining VIBE_* fields
  // are validated centrally in `buildPathScriptEnv` below.
  assertNoControlChars("VIBE_REPO_ROOT", context.repoRoot);

  // Expand ~ to home directory with validation
  const home = runtime.env.get("HOME") ?? "";
  const isValidHome = home.length > 0 && isAbsolute(home) && !home.includes("..");
  if (scriptPath.startsWith("~") && !isValidHome) {
    throw new Error(
      "Cannot expand ~ in path_script: HOME environment variable is invalid or not set.",
    );
  }
  const expandedPath = scriptPath.replace(/^~/, home);

  // Resolve relative paths against repoRoot
  const resolvedPath = isAbsolute(expandedPath)
    ? expandedPath
    : join(context.repoRoot, expandedPath);

  // Check if script exists
  try {
    const stat = await runtime.fs.stat(resolvedPath);
    const isNotFile = !stat.isFile;
    if (isNotFile) {
      throw new Error(`Worktree path script is not a file: ${resolvedPath}`);
    }
  } catch (error) {
    const isNotFoundError = runtime.errors.isNotFound(error);
    if (isNotFoundError) {
      throw new Error(`Worktree path script not found: ${resolvedPath}`);
    }
    throw error;
  }

  const env = buildPathScriptEnv(context, runtime.env.toObject());

  // Execute the script with environment variables
  const result = await runtime.process.run({
    cmd: resolvedPath,
    env,
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = result;

  const isScriptFailed = code !== 0;
  if (isScriptFailed) {
    const errorOutput = new TextDecoder().decode(stderr);
    throw new Error(`Worktree path script failed: ${errorOutput}`);
  }

  const rawOutput = new TextDecoder().decode(stdout);

  // Layer 3: reject control characters in stdout BEFORE trimming. A script that
  // emits embedded newlines may be smuggling extra paths past downstream
  // consumers. NOTE: this validates only the syntactic shape — semantic
  // checks like path traversal (`../`, symlink escapes) are out of scope and
  // tracked separately in #419.
  assertOutputHasNoControlChars(rawOutput);

  const path = rawOutput.trim();

  // Validate that the path is absolute
  const isPathEmpty = !path;
  const isPathRelative = !isAbsolute(path);
  if (isPathEmpty || isPathRelative) {
    throw new Error(`Worktree path script must output an absolute path, got: ${path}`);
  }

  return path;
}
