import { parseArgs } from "@std/cli/parse-args";
import { startCommand } from "./src/commands/start.ts";
import { cleanCommand } from "./src/commands/clean.ts";
import { trustCommand } from "./src/commands/trust.ts";

const HELP_TEXT = `vibe - git worktree helper

Usage:
  vibe start <branch-name> [--reuse]  Create a new worktree with the given branch
  vibe clean                          Remove current worktree and return to main
  vibe trust                          Trust .vibe file in current repository

Options:
  --reuse  Use existing branch instead of creating a new one

Setup:
  Add this to your .zshrc:
    vibe() { eval "$(command vibe "$@")" }

Examples:
  vibe trust
  vibe start feat/new-feature
  vibe start feat/existing --reuse
  vibe clean
`;

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    boolean: ["help", "reuse"],
    alias: { h: "help" },
  });

  const showHelp = args.help || args._.length === 0;
  if (showHelp) {
    console.log(HELP_TEXT);
    Deno.exit(0);
  }

  const command = String(args._[0]);

  switch (command) {
    case "start": {
      const branchName = String(args._[1] ?? "");
      const reuse = args.reuse;
      await startCommand(branchName, { reuse });
      break;
    }
    case "clean":
      await cleanCommand();
      break;
    case "trust":
      await trustCommand();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      Deno.exit(1);
  }
}

main();
