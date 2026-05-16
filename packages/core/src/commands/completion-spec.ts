// Single source of truth for vibe's CLI subcommand and flag metadata.
// Consumed by fish-completion.ts and zsh-completion.ts to generate shell-specific
// completion scripts, and by cli-flags-consistency.test.ts to cross-check that
// parseArgsOptions in main.ts stays aligned with what users see in `vibe --help`.

export interface FlagSpec {
  long: string;
  short?: string;
  description: string;
  takesValue?: boolean;
  valueCandidates?: readonly string[];
}

/**
 * Kind of dynamic completion offered for a subcommand's first positional arg.
 *
 * - `all-branches` — every local branch (`git for-each-ref refs/heads`)
 * - `worktree-branches` — only branches currently checked out as a worktree
 */
export type PositionalCompletion = "all-branches" | "worktree-branches";

export interface CommandSpec {
  name: string;
  description: string;
  flags?: readonly FlagSpec[];
  positionalCompletion?: PositionalCompletion;
}

export const SUBCOMMANDS: readonly CommandSpec[] = [
  {
    name: "start",
    description: "Create a new worktree with the given branch",
    positionalCompletion: "all-branches",
    flags: [
      { long: "reuse", description: "Use existing branch instead of creating a new one" },
      { long: "base", description: "Base branch/commit for new branch", takesValue: true },
      { long: "track", description: "Set upstream tracking when using --base" },
      { long: "no-hooks", description: "Skip pre-start and post-start hooks" },
      { long: "no-copy", description: "Skip copying files and directories" },
      { long: "dry-run", short: "n", description: "Show what would be executed" },
      { long: "force", short: "f", description: "Skip confirmation prompts" },
    ],
  },
  {
    name: "scratch",
    description: "Create a worktree with an auto-generated scratch/<timestamp> branch",
    flags: [
      { long: "reuse", description: "Use existing branch instead of creating a new one" },
      { long: "base", description: "Base branch/commit for new branch", takesValue: true },
      { long: "track", description: "Set upstream tracking when using --base" },
      { long: "no-hooks", description: "Skip pre-start and post-start hooks" },
      { long: "no-copy", description: "Skip copying files and directories" },
      { long: "dry-run", short: "n", description: "Show what would be executed" },
    ],
  },
  {
    name: "jump",
    description: "Jump to an existing worktree by branch name",
    positionalCompletion: "worktree-branches",
  },
  {
    name: "rename",
    description: "Rename the current worktree's branch and directory",
    flags: [{ long: "dry-run", short: "n", description: "Show what would be executed" }],
  },
  {
    name: "clean",
    description: "Remove current worktree and return to main",
    flags: [
      { long: "force", short: "f", description: "Skip confirmation prompts" },
      { long: "delete-branch", description: "Delete the branch after removing the worktree" },
      { long: "keep-branch", description: "Keep the branch after removing the worktree" },
    ],
  },
  { name: "home", description: "Return to main worktree without removing current" },
  { name: "trust", description: "Trust .vibe.toml in current repository" },
  { name: "untrust", description: "Remove trust for .vibe.toml in current repository" },
  { name: "verify", description: "Verify trust status and hash history" },
  { name: "config", description: "Show current settings" },
  {
    name: "upgrade",
    description: "Check for updates and show upgrade instructions",
    flags: [{ long: "check", description: "Check for updates without upgrade instructions" }],
  },
  {
    name: "shell-setup",
    description: "Print shell wrapper function for eval",
    flags: [
      {
        long: "shell",
        description: "Specify shell type",
        takesValue: true,
        valueCandidates: ["bash", "zsh", "fish", "nushell", "powershell"],
      },
      {
        long: "with-completion",
        description: "Append shell autocompletion script to shell-setup output",
      },
    ],
  },
];

export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { long: "help", short: "h", description: "Show help message" },
  { long: "version", short: "v", description: "Show version information" },
  { long: "verbose", short: "V", description: "Show detailed output" },
  { long: "quiet", short: "q", description: "Suppress non-essential output" },
];
