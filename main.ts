import { parseArgs, type ParseArgsConfig } from "node:util";
import { startCommand } from "./packages/core/src/commands/start.ts";
import { cleanCommand } from "./packages/core/src/commands/clean.ts";
import { homeCommand } from "./packages/core/src/commands/home.ts";
import { trustCommand } from "./packages/core/src/commands/trust.ts";
import { untrustCommand } from "./packages/core/src/commands/untrust.ts";
import { verifyCommand } from "./packages/core/src/commands/verify.ts";
import { configCommand } from "./packages/core/src/commands/config.ts";
import { jumpCommand } from "./packages/core/src/commands/jump.ts";
import { upgradeCommand } from "./packages/core/src/commands/upgrade.ts";
import { shellSetupCommand } from "./packages/core/src/commands/shell-setup.ts";
import { BUILD_INFO } from "./packages/core/src/version.ts";
import { initRuntime, runtime } from "./packages/core/src/runtime/index.ts";
import {
  createAppContext,
  getGlobalContext,
  setGlobalContext,
} from "./packages/core/src/context/index.ts";
import { handleError } from "./packages/core/src/errors/index.ts";

/**
 * CLI options configuration for node:util parseArgs
 */
const parseArgsOptions: ParseArgsConfig["options"] = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  verbose: { type: "boolean", short: "V" },
  quiet: { type: "boolean", short: "q" },
  reuse: { type: "boolean" },
  "no-hooks": { type: "boolean" },
  "no-copy": { type: "boolean" },
  "dry-run": { type: "boolean", short: "n" },
  force: { type: "boolean", short: "f" },
  "delete-branch": { type: "boolean" },
  "keep-branch": { type: "boolean" },
  check: { type: "boolean" },
  base: { type: "string" },
  track: { type: "boolean" },
  shell: { type: "string" },
};

const HELP_TEXT = `vibe - git worktree helper

Installation:
  # npx (Node.js)
  npx @kexi/vibe

  # Homebrew (macOS)
  brew install kexi/tap/vibe

  # Manual build
  bun build --compile --minify --outfile vibe main.ts

Usage:
  vibe start <branch-name> [options]  Create a new worktree with the given branch
  vibe jump <branch-name> [options]   Jump to an existing worktree by branch name
  vibe clean [options]                Remove current worktree and return to main
  vibe home                           Return to main worktree without removing current
  vibe trust                          Trust .vibe.toml in current repository
  vibe untrust                        Remove trust for .vibe.toml in current repository
  vibe verify                         Verify trust status and hash history
  vibe config                         Show current settings
  vibe upgrade [options]              Check for updates and show upgrade instructions
  vibe shell-setup [options]          Print shell wrapper function for eval

Global Options:
  -h, --help        Show this help message
  -v, --version     Show version information
  -V, --verbose     Show detailed output
  -q, --quiet       Suppress non-essential output

Command Options:
  --reuse           Use existing branch instead of creating a new one (start)
  --base <ref>      Base branch/commit for new branch (start)
  --track           Set upstream tracking when using --base (start)
  --no-hooks        Skip pre-start and post-start hooks (start)
  --no-copy         Skip copying files and directories (start)
  -n, --dry-run     Show what would be executed without making changes (start)
  -f, --force       Skip confirmation prompts (clean)
  --delete-branch   Delete the branch after removing the worktree (clean)
  --keep-branch     Keep the branch after removing the worktree (clean)
  --check           Check for updates without showing upgrade instructions (upgrade)
  --shell <name>    Specify shell type: bash, zsh, fish, nushell, powershell (shell-setup)

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
  vibe start feat/new-feature --base main
  vibe jump feat/new-feature
  vibe clean
  vibe home
`;

async function main(): Promise<void> {
  // Initialize runtime before using any runtime APIs
  const rt = await initRuntime();

  // Set up global context for dependency injection
  setGlobalContext(createAppContext(rt));

  const rawArgs = [...runtime.control.args];

  let parsedArgs: ReturnType<typeof parseArgs>;
  try {
    parsedArgs = parseArgs({
      args: rawArgs,
      options: parseArgsOptions,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    if (error instanceof Error) {
      // Extract option name from error message for better UX
      const match = error.message.match(/Unknown option '(.+)'/);
      if (match) {
        console.error(`Error: Unknown option '${match[1]}'`);
      } else {
        console.error(`Error: ${error.message}`);
      }
    }
    console.error("Run 'vibe --help' for usage.");
    runtime.control.exit(1);
  }

  const { values: args, positionals } = parsedArgs;

  // Warn when both --verbose and --quiet are specified.
  // Note: Warnings and errors always display regardless of --quiet flag,
  // as they indicate issues the user should be aware of.
  const hasConflictingOutputOptions = args.verbose && args.quiet;
  if (hasConflictingOutputOptions) {
    console.error("Warning: Both --verbose and --quiet specified. Using --quiet.");
  }

  if (args.version) {
    console.error(`vibe ${BUILD_INFO.version}`);
    console.error(`Platform: ${BUILD_INFO.platform}-${BUILD_INFO.arch} (${BUILD_INFO.target})`);
    console.error(`Distribution: ${BUILD_INFO.distribution}`);
    console.error(`Built: ${BUILD_INFO.buildTime} (${BUILD_INFO.buildEnv})`);
    console.error();
    console.error(`${BUILD_INFO.repository}#readme`);
    runtime.control.exit(0);
  }

  const showHelp = args.help || positionals.length === 0;
  if (showHelp) {
    console.error(HELP_TEXT);
    console.error(`${BUILD_INFO.repository}#readme`);
    runtime.control.exit(0);
  }

  const command = String(positionals[0]);

  switch (command) {
    case "start": {
      const branchName = String(positionals[1] ?? "");
      const reuse = args.reuse === true;
      const noHooks = args["no-hooks"] === true;
      const noCopy = args["no-copy"] === true;
      const dryRun = args["dry-run"] === true;
      const verbose = args.verbose === true;
      const quiet = args.quiet === true;
      const base =
        typeof args.base === "string" ? args.base : args.base === undefined ? undefined : "";
      const baseFromEquals = rawArgs.some((arg) => arg.startsWith("--base="));
      const track = args.track === true;
      await startCommand(branchName, {
        reuse,
        noHooks,
        noCopy,
        dryRun,
        verbose,
        quiet,
        base,
        baseFromEquals,
        track,
      });
      break;
    }
    case "jump": {
      const branchName = String(positionals[1] ?? "");
      const verbose = args.verbose === true;
      const quiet = args.quiet === true;
      await jumpCommand(branchName, { verbose, quiet });
      break;
    }
    case "clean": {
      const force = args.force === true;
      const deleteBranch = args["delete-branch"] === true;
      const keepBranch = args["keep-branch"] === true;
      const verbose = args.verbose === true;
      const quiet = args.quiet === true;

      // Validate mutually exclusive options
      const hasMutuallyExclusiveOptions = deleteBranch && keepBranch;
      if (hasMutuallyExclusiveOptions) {
        console.error("Error: --delete-branch and --keep-branch cannot be used together");
        runtime.control.exit(1);
      }

      await cleanCommand({ force, deleteBranch, keepBranch, verbose, quiet });
      break;
    }
    case "home": {
      const verbose = args.verbose === true;
      const quiet = args.quiet === true;
      await homeCommand({ verbose, quiet });
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
      const check = args.check === true;
      const verbose = args.verbose === true;
      const quiet = args.quiet === true;
      await upgradeCommand({ check, verbose, quiet });
      break;
    }
    case "shell-setup": {
      const verbose = args.verbose === true;
      const quiet = args.quiet === true;
      const shell = typeof args.shell === "string" ? args.shell : undefined;
      await shellSetupCommand({ verbose, quiet, shell });
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      runtime.control.exit(1);
  }

  // Explicitly exit to ensure process terminates even if there are pending event listeners
  runtime.control.exit(0);
}

main().catch((error) => {
  const ctx = getGlobalContext();
  const exitCode = handleError(error, {}, ctx);
  const shouldExit = exitCode !== 0;
  if (shouldExit) {
    ctx.runtime.control.exit(exitCode);
  }
});
