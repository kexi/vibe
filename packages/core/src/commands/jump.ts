import { getWorktreeList } from "../utils/git.ts";
import { confirm, select } from "../utils/prompt.ts";
import { log, type OutputOptions, verboseLog } from "../utils/output.ts";
import { formatCdCommand } from "../utils/shell.ts";
import { startCommand } from "./start.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";

/**
 * Handle partial matches - select or navigate to matching worktrees
 * @returns true if a match was handled, false if no matches
 */
async function handlePartialMatches(
  matches: { path: string; branch: string }[],
  branchName: string,
  outputOpts: OutputOptions,
  ctx: AppContext,
): Promise<boolean> {
  const hasSingleMatch = matches.length === 1;
  if (hasSingleMatch) {
    const match = matches[0];
    verboseLog(`Partial match found: ${match.branch} -> ${match.path}`, outputOpts);
    log(`Matched: ${match.branch}`, outputOpts);
    console.log(formatCdCommand(match.path));
    return true;
  }

  const hasMultipleMatches = matches.length > 1;
  if (hasMultipleMatches) {
    verboseLog(`Multiple partial matches found: ${matches.length}`, outputOpts);

    const choices = matches.map((w) => `${w.branch} (${w.path})`);
    choices.push("Cancel");

    const selected = await select(`Multiple worktrees match '${branchName}':`, choices, ctx);

    const isCancelled = selected === choices.length - 1;
    if (isCancelled) {
      console.error("Cancelled");
      return true;
    }

    const selectedWorktree = matches[selected];
    console.log(formatCdCommand(selectedWorktree.path));
    return true;
  }

  return false;
}

/**
 * Jump command - navigate to an existing worktree by branch name
 */
export async function jumpCommand(
  branchName: string,
  options: OutputOptions = {},
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const { runtime } = ctx;
  const { verbose = false, quiet = false } = options;
  const outputOpts: OutputOptions = { verbose, quiet };

  const trimmedBranchName = branchName.trim();
  const isBranchNameEmpty = !trimmedBranchName;
  if (isBranchNameEmpty) {
    console.error("Error: Branch name is required");
    runtime.control.exit(1);
    return;
  }

  try {
    const worktrees = await getWorktreeList(ctx);

    verboseLog(`Found ${worktrees.length} worktree(s)`, outputOpts);

    // Exact match (case-sensitive)
    const exactMatch = worktrees.find((w) => w.branch === trimmedBranchName);
    if (exactMatch) {
      verboseLog(`Exact match found: ${exactMatch.branch} -> ${exactMatch.path}`, outputOpts);
      console.log(formatCdCommand(exactMatch.path));
      return;
    }

    // Exact match (case-insensitive)
    const lowerBranchName = trimmedBranchName.toLowerCase();
    const exactMatchCI = worktrees.find((w) => w.branch.toLowerCase() === lowerBranchName);
    if (exactMatchCI) {
      verboseLog(
        `Exact match found (case-insensitive): ${exactMatchCI.branch} -> ${exactMatchCI.path}`,
        outputOpts,
      );
      log(`Matched: ${exactMatchCI.branch}`, outputOpts);
      console.log(formatCdCommand(exactMatchCI.path));
      return;
    }

    // Partial match (case-sensitive)
    const partialMatches = worktrees.filter((w) => w.branch.includes(trimmedBranchName));

    const handled = await handlePartialMatches(partialMatches, trimmedBranchName, outputOpts, ctx);
    if (handled) {
      return;
    }

    // Partial match (case-insensitive fallback)
    const partialMatchesCI = worktrees.filter((w) =>
      w.branch.toLowerCase().includes(lowerBranchName),
    );

    const handledCI = await handlePartialMatches(
      partialMatchesCI,
      trimmedBranchName,
      outputOpts,
      ctx,
    );
    if (handledCI) {
      return;
    }

    // No match found
    log(`No worktree found for '${trimmedBranchName}'`, outputOpts);

    const shouldCreate = await confirm(
      `No worktree found for '${trimmedBranchName}'. Create one with 'vibe start'? (Y/n)`,
      ctx,
    );

    if (shouldCreate) {
      await startCommand(trimmedBranchName, {}, ctx);
    } else {
      console.error("Cancelled");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    runtime.control.exit(1);
  }
}
