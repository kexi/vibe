import { getWorktreeList } from "../utils/git.ts";
import { confirm, select } from "../utils/prompt.ts";
import { log, type OutputOptions, verboseLog } from "../utils/output.ts";
import { formatCdCommand } from "../utils/shell.ts";
import { startCommand } from "./start.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";

/** Word boundary delimiters in branch names */
const WORD_BOUNDARY_CHARS = new Set(["/", "-", "_"]);

/**
 * Check if search term appears at a word boundary in the branch name.
 * A word boundary is the start of the string, or immediately after /, -, or _.
 */
function isWordBoundaryMatch(branch: string, search: string): boolean {
  const index = branch.indexOf(search);
  const isNotFound = index === -1;
  if (isNotFound) return false;

  const isAtStart = index === 0;
  if (isAtStart) return true;

  const charBefore = branch[index - 1];
  return WORD_BOUNDARY_CHARS.has(charBefore);
}

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

    // Word boundary match (case-sensitive)
    const wordBoundaryMatches = worktrees.filter((w) =>
      isWordBoundaryMatch(w.branch, trimmedBranchName),
    );

    const handledWB = await handlePartialMatches(
      wordBoundaryMatches,
      trimmedBranchName,
      outputOpts,
      ctx,
    );
    if (handledWB) {
      return;
    }

    // Word boundary match (case-insensitive)
    const wordBoundaryMatchesCI = worktrees.filter((w) =>
      isWordBoundaryMatch(w.branch.toLowerCase(), lowerBranchName),
    );

    const handledWBCI = await handlePartialMatches(
      wordBoundaryMatchesCI,
      trimmedBranchName,
      outputOpts,
      ctx,
    );
    if (handledWBCI) {
      return;
    }

    // Substring match (case-sensitive)
    const substringMatches = worktrees.filter((w) => w.branch.includes(trimmedBranchName));

    const handledSub = await handlePartialMatches(
      substringMatches,
      trimmedBranchName,
      outputOpts,
      ctx,
    );
    if (handledSub) {
      return;
    }

    // Substring match (case-insensitive fallback)
    const substringMatchesCI = worktrees.filter((w) =>
      w.branch.toLowerCase().includes(lowerBranchName),
    );

    const handledSubCI = await handlePartialMatches(
      substringMatchesCI,
      trimmedBranchName,
      outputOpts,
      ctx,
    );
    if (handledSubCI) {
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
