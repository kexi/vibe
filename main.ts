import { parseArgs } from "@std/cli/parse-args";
import { startCommand } from "./src/commands/start.ts";
import { cleanCommand } from "./src/commands/clean.ts";
import { trustCommand } from "./src/commands/trust.ts";
import { untrustCommand } from "./src/commands/untrust.ts";
import { verifyCommand } from "./src/commands/verify.ts";
import { configCommand } from "./src/commands/config.ts";
import { upgradeCommand } from "./src/commands/upgrade.ts";
import { BUILD_INFO } from "./src/version.ts";

/**
 * Boolean options supported by the CLI.
 * Single source of truth for option parsing and validation.
 */
const BOOLEAN_OPTIONS = [
  "help",
  "version",
  "verbose",
  "quiet",
  "reuse",
  "no-hooks",
  "no-copy",
  "dry-run",
  "force",
  "delete-branch",
  "keep-branch",
  "check",
] as const;

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
  deno compile --allow-run --allow-read --allow-write --allow-env --allow-ffi --allow-net --output vibe main.ts

Usage:
  vibe start <branch-name> [options]  Create a new worktree with the given branch
  vibe clean [options]                Remove current worktree and return to main
  vibe trust                          Trust .vibe.toml in current repository
  vibe untrust                        Remove trust for .vibe.toml in current repository
  vibe verify                         Verify trust status and hash history
  vibe config                         Show current settings
  vibe upgrade [options]              Check for updates and show upgrade instructions

Options:
  -h, --help        Show this help message
  -v, --version     Show version information
  -V, --verbose     Show detailed output
  -q, --quiet       Suppress non-essential output
  --reuse           Use existing branch instead of creating a new one
  --no-hooks        Skip pre-start and post-start hooks
  --no-copy         Skip copying files and directories
  -n, --dry-run     Show what would be executed without making changes
  -f, --force       Skip confirmation prompts (for clean command)
  --delete-branch   Delete the branch after removing the worktree
  --keep-branch     Keep the branch after removing the worktree
  --check           Check for updates without showing upgrade instructions (upgrade command)

Setup:
  Add this to your .zshrc:
    vibe() { eval "$(command vibe "$@")" }

Examples:
  vibe trust
  vibe untrust
  vibe verify
  vibe config
  vibe upgrade
  vibe upgrade --check
  vibe start feat/new-feature
  vibe start feat/existing --reuse
  vibe clean
`;

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    boolean: [...BOOLEAN_OPTIONS],
    alias: {
      h: "help",
      v: "version",
      V: "verbose",
      q: "quiet",
      n: "dry-run",
      f: "force",
    },
  });

  // Check for unknown options (includes "_" for positional args and alias keys)
  const ALIAS_KEYS = ["h", "v", "V", "q", "n", "f"] as const;
  const knownOptions = new Set<string>([...BOOLEAN_OPTIONS, "_", ...ALIAS_KEYS]);

  for (const key of Object.keys(args)) {
    const isUnknownOption = !knownOptions.has(key);
    if (isUnknownOption) {
      console.error(`Error: Unknown option '--${key}'`);
      console.error("Run 'vibe --help' for usage.");
      Deno.exit(1);
    }
  }

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
      const verbose = args.verbose;
      const quiet = args.quiet;
      await startCommand(branchName, { reuse, noHooks, noCopy, dryRun, verbose, quiet });
      break;
    }
    case "clean": {
      const force = args.force;
      const deleteBranch = args["delete-branch"];
      const keepBranch = args["keep-branch"];
      const verbose = args.verbose;
      const quiet = args.quiet;

      // Validate mutually exclusive options
      const hasMutuallyExclusiveOptions = deleteBranch && keepBranch;
      if (hasMutuallyExclusiveOptions) {
        console.error(
          "Error: --delete-branch and --keep-branch cannot be used together",
        );
        Deno.exit(1);
      }

      await cleanCommand({ force, deleteBranch, keepBranch, verbose, quiet });
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
    case "upgrade": {
      const check = args.check;
      const verbose = args.verbose;
      const quiet = args.quiet;
      await upgradeCommand({ check, verbose, quiet });
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      Deno.exit(1);
  }
}

main();
