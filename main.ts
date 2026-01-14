import { parseArgs } from "@std/cli/parse-args";
import { startCommand } from "./src/commands/start.ts";
import { cleanCommand } from "./src/commands/clean.ts";
import { trustCommand } from "./src/commands/trust.ts";
import { untrustCommand } from "./src/commands/untrust.ts";
import { verifyCommand } from "./src/commands/verify.ts";
import { configCommand } from "./src/commands/config.ts";
import { BUILD_INFO } from "./src/version.ts";

const HELP_TEXT = `vibe - git worktree helper

Installation:
  # Homebrew (macOS)
  brew install kexi/tap/vibe

  # Deno (Cross-platform)
  deno install -A --global jsr:@kexi/vibe

  # mise (.mise.toml)
  [tools]
  "jsr:@kexi/vibe" = "latest"

  # Manual build
  deno compile --allow-run --allow-read --allow-write --allow-env --allow-ffi --output vibe main.ts

Usage:
  vibe start <branch-name> [options]  Create a new worktree with the given branch
  vibe clean [options]                Remove current worktree and return to main
  vibe trust                          Trust .vibe.toml in current repository
  vibe untrust                        Remove trust for .vibe.toml in current repository
  vibe verify                         Verify trust status and hash history
  vibe config                         Show current settings

Options:
  -h, --help        Show this help message
  -v, --version     Show version information
  --reuse           Use existing branch instead of creating a new one
  --no-hooks        Skip pre-start and post-start hooks
  --no-copy         Skip copying files and directories
  --dry-run         Show what would be executed without making changes
  -f, --force       Skip confirmation prompts (for clean command)
  --delete-branch   Delete the branch after removing the worktree
  --keep-branch     Keep the branch after removing the worktree

Setup:
  Add this to your .zshrc:
    vibe() { eval "$(command vibe "$@")" }

Examples:
  vibe trust
  vibe untrust
  vibe verify
  vibe config
  vibe start feat/new-feature
  vibe start feat/existing --reuse
  vibe clean
`;

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    boolean: [
      "help",
      "version",
      "reuse",
      "no-hooks",
      "no-copy",
      "dry-run",
      "force",
      "delete-branch",
      "keep-branch",
    ],
    alias: { h: "help", v: "version", f: "force" },
  });

  if (args.version) {
    console.error(`vibe ${BUILD_INFO.version}`);
    console.error(
      `Platform: ${BUILD_INFO.platform}-${BUILD_INFO.arch} (${BUILD_INFO.target})`,
    );
    console.error(`Distribution: ${BUILD_INFO.distribution}`);
    console.error(`Built: ${BUILD_INFO.buildTime} (${BUILD_INFO.buildEnv})`);
    console.error();
    console.error(`${BUILD_INFO.repository}#readme`);
    Deno.exit(0);
  }

  const showHelp = args.help || args._.length === 0;
  if (showHelp) {
    console.error(HELP_TEXT);
    console.error(`${BUILD_INFO.repository}#readme`);
    Deno.exit(0);
  }

  const command = String(args._[0]);

  switch (command) {
    case "start": {
      const branchName = String(args._[1] ?? "");
      const reuse = args.reuse;
      const noHooks = args["no-hooks"];
      const noCopy = args["no-copy"];
      const dryRun = args["dry-run"];
      await startCommand(branchName, { reuse, noHooks, noCopy, dryRun });
      break;
    }
    case "clean": {
      const force = args.force;
      const deleteBranch = args["delete-branch"];
      const keepBranch = args["keep-branch"];
      await cleanCommand({ force, deleteBranch, keepBranch });
      break;
    }
    case "trust":
      await trustCommand();
      break;
    case "untrust":
      await untrustCommand();
      break;
    case "verify":
      await verifyCommand();
      break;
    case "config":
      await configCommand();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      Deno.exit(1);
  }
}

main();
