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
  deno compile --allow-run --allow-read --allow-write --allow-env --output vibe main.ts

Usage:
  vibe start <branch-name> [--reuse]  Create a new worktree with the given branch
  vibe clean                          Remove current worktree and return to main
  vibe trust                          Trust .vibe.toml in current repository
  vibe untrust                        Remove trust for .vibe.toml in current repository
  vibe verify                         Verify trust status and hash history
  vibe config                         Show current settings

Options:
  -h, --help     Show this help message
  -v, --version  Show version information
  --reuse        Use existing branch instead of creating a new one

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
    boolean: ["help", "version", "reuse"],
    alias: { h: "help", v: "version" },
  });

  if (args.version) {
    console.log(`vibe ${BUILD_INFO.version}`);
    console.log(
      `Platform: ${BUILD_INFO.platform}-${BUILD_INFO.arch} (${BUILD_INFO.target})`,
    );
    console.log(`Distribution: ${BUILD_INFO.distribution}`);
    console.log(`Built: ${BUILD_INFO.buildTime} (${BUILD_INFO.buildEnv})`);
    console.log();
    console.log(`${BUILD_INFO.repository}#readme`);
    Deno.exit(0);
  }

  const showHelp = args.help || args._.length === 0;
  if (showHelp) {
    console.log(HELP_TEXT);
    console.log(`${REPOSITORY_URL}#readme`);
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
