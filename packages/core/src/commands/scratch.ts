import { type AppContext, getGlobalContext } from "../context/index.ts";
import { getWorktreeList, runGitCommand } from "../utils/git.ts";
import { formatLocalTimestamp } from "../utils/timestamp.ts";
import { errorLog, log, type OutputOptions } from "../utils/output.ts";
import { startCommand } from "./start.ts";

const MAX_COLLISION_RETRIES = 100;

/** Branch-name prefix used by `vibe scratch` for auto-named worktrees */
export const SCRATCH_PREFIX = "scratch/";

export interface ScratchOptions extends OutputOptions {
  reuse?: boolean;
  noHooks?: boolean;
  noCopy?: boolean;
  dryRun?: boolean;
  base?: string;
  baseFromEquals?: boolean;
  track?: boolean;
}

/**
 * Generate a unique scratch branch name based on the current local time.
 * If `scratch/<timestamp>` already exists (as a branch or worktree), append
 * `-2`, `-3`, ... until a free name is found. Throws after MAX_COLLISION_RETRIES.
 *
 * Worktree paths and existing scratch branches are fetched once up-front
 * (in parallel) so the collision loop does not spawn git subprocesses per iteration.
 */
async function generateScratchName(ctx: AppContext): Promise<string> {
  const ts = formatLocalTimestamp(Date.now());
  const baseName = `${SCRATCH_PREFIX}${ts}`;

  const [worktrees, scratchBranchOutput] = await Promise.all([
    getWorktreeList(ctx),
    runGitCommand(
      ["for-each-ref", "--format=%(refname:short)", `refs/heads/${SCRATCH_PREFIX}`],
      ctx,
    ).catch(() => ""),
  ]);

  const used = new Set<string>();
  for (const w of worktrees) used.add(w.branch);
  for (const line of scratchBranchOutput.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") used.add(trimmed);
  }

  for (let i = 1; i <= MAX_COLLISION_RETRIES; i++) {
    const candidate = i === 1 ? baseName : `${baseName}-${i}`;
    if (!used.has(candidate)) return candidate;
  }

  throw new Error(`Could not generate unique scratch name after ${MAX_COLLISION_RETRIES} attempts`);
}

/**
 * Create a worktree with an auto-generated `scratch/<timestamp>` branch name.
 * Behavior is otherwise identical to `vibe start`.
 */
export async function scratchCommand(
  options: ScratchOptions = {},
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const { runtime } = ctx;
  const { verbose = false, quiet = false } = options;
  const outputOpts: OutputOptions = { verbose, quiet };

  let branchName: string;
  try {
    branchName = await generateScratchName(ctx);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errorLog(`Error: ${msg}`, outputOpts);
    runtime.control.exit(1);
    return;
  }

  await startCommand(
    branchName,
    {
      reuse: options.reuse,
      noHooks: options.noHooks,
      noCopy: options.noCopy,
      dryRun: options.dryRun,
      base: options.base,
      baseFromEquals: options.baseFromEquals,
      track: options.track,
      verbose,
      quiet,
    },
    ctx,
  );

  log(`Promote with: vibe rename <new-name>`, outputOpts);
}
