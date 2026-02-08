import { getWorktreeList } from "../utils/git.ts";
import { confirm, select } from "../utils/prompt.ts";
import { log, type OutputOptions, verboseLog } from "../utils/output.ts";
import { formatCdCommand } from "../utils/shell.ts";
import { startCommand } from "./start.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";

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

  const isBranchNameEmpty = !branchName;
  if (isBranchNameEmpty) {
    console.error("Error: Branch name is required");
    runtime.control.exit(1);
    return;
  }

  try {
    const worktrees = await getWorktreeList(ctx);

    verboseLog(`Found ${worktrees.length} worktree(s)`, outputOpts);

    // Exact match
    const exactMatch = worktrees.find((w) => w.branch === branchName);
    if (exactMatch) {
      verboseLog(`Exact match found: ${exactMatch.branch} -> ${exactMatch.path}`, outputOpts);
      console.log(formatCdCommand(exactMatch.path));
      return;
    }

    // Partial match
    const partialMatches = worktrees.filter((w) => w.branch.includes(branchName));

    const hasSingleMatch = partialMatches.length === 1;
    if (hasSingleMatch) {
      const match = partialMatches[0];
      verboseLog(`Partial match found: ${match.branch} -> ${match.path}`, outputOpts);
      log(`Matched: ${match.branch}`, outputOpts);
      console.log(formatCdCommand(match.path));
      return;
    }

    const hasMultipleMatches = partialMatches.length > 1;
    if (hasMultipleMatches) {
      verboseLog(`Multiple partial matches found: ${partialMatches.length}`, outputOpts);

      const choices = partialMatches.map((w) => `${w.branch} (${w.path})`);
      choices.push("Cancel");

      const selected = await select(`Multiple worktrees match '${branchName}':`, choices, ctx);

      const isCancelled = selected === choices.length - 1;
      if (isCancelled) {
        console.error("Cancelled");
        return;
      }

      const selectedWorktree = partialMatches[selected];
      console.log(formatCdCommand(selectedWorktree.path));
      return;
    }

    // No match found
    log(`No worktree found for '${branchName}'`, outputOpts);

    const shouldCreate = await confirm(
      `No worktree found for '${branchName}'. Create one with 'vibe start'? (Y/n)`,
      ctx,
    );

    if (shouldCreate) {
      await startCommand(branchName, {}, ctx);
    } else {
      console.error("Cancelled");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    runtime.control.exit(1);
  }
}
