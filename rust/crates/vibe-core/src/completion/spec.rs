//! Single source of truth for vibe's subcommand/flag metadata.
//!
//! Ported from `packages/core/src/commands/completion-spec.ts`. Consumed by the
//! fish/zsh generators and cross-checked against the clap `cli.rs` flags by a
//! consistency test, exactly as the TS `completion-spec.ts` was the SSoT for its
//! generators and `cli-flags-consistency.test.ts`.

/// Dynamic completion offered for a subcommand's first positional argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PositionalCompletion {
    /// Every local branch (`git for-each-ref refs/heads`).
    AllBranches,
    /// Only branches currently checked out as a worktree.
    WorktreeBranches,
}

/// A single flag's metadata.
#[derive(Debug, Clone, Copy)]
pub struct FlagSpec {
    pub long: &'static str,
    pub short: Option<&'static str>,
    pub description: &'static str,
    pub takes_value: bool,
    pub value_candidates: Option<&'static [&'static str]>,
}

impl FlagSpec {
    /// A boolean flag (no value).
    const fn flag(long: &'static str, description: &'static str) -> Self {
        FlagSpec {
            long,
            short: None,
            description,
            takes_value: false,
            value_candidates: None,
        }
    }

    /// A boolean flag with a short alias.
    const fn flag_short(
        long: &'static str,
        short: &'static str,
        description: &'static str,
    ) -> Self {
        FlagSpec {
            long,
            short: Some(short),
            description,
            takes_value: false,
            value_candidates: None,
        }
    }

    /// A flag that takes a value.
    const fn value(long: &'static str, description: &'static str) -> Self {
        FlagSpec {
            long,
            short: None,
            description,
            takes_value: true,
            value_candidates: None,
        }
    }

    /// A value flag with a fixed candidate set.
    const fn value_candidates(
        long: &'static str,
        description: &'static str,
        candidates: &'static [&'static str],
    ) -> Self {
        FlagSpec {
            long,
            short: None,
            description,
            takes_value: true,
            value_candidates: Some(candidates),
        }
    }
}

/// A subcommand's metadata.
#[derive(Debug, Clone, Copy)]
pub struct CommandSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub flags: &'static [FlagSpec],
    pub positional_completion: Option<PositionalCompletion>,
}

const SHELL_CANDIDATES: [&str; 5] = ["bash", "zsh", "fish", "nushell", "powershell"];

/// All vibe subcommands, in display order (matches the TS array order).
pub const SUBCOMMANDS: &[CommandSpec] = &[
    CommandSpec {
        name: "start",
        description: "Create a new worktree with the given branch",
        positional_completion: Some(PositionalCompletion::AllBranches),
        flags: &[
            FlagSpec::flag("reuse", "Use existing branch instead of creating a new one"),
            FlagSpec::value("base", "Base branch/commit for new branch"),
            FlagSpec::flag("track", "Set upstream tracking when using --base"),
            FlagSpec::flag("no-hooks", "Skip pre-start and post-start hooks"),
            FlagSpec::flag("no-copy", "Skip copying files and directories"),
            FlagSpec::flag_short("dry-run", "n", "Show what would be executed"),
            FlagSpec::flag_short("force", "f", "Skip confirmation prompts"),
        ],
    },
    CommandSpec {
        name: "scratch",
        description: "Create a worktree with an auto-generated scratch/<timestamp> branch",
        positional_completion: None,
        flags: &[
            FlagSpec::flag("reuse", "Use existing branch instead of creating a new one"),
            FlagSpec::value("base", "Base branch/commit for new branch"),
            FlagSpec::flag("track", "Set upstream tracking when using --base"),
            FlagSpec::flag("no-hooks", "Skip pre-start and post-start hooks"),
            FlagSpec::flag("no-copy", "Skip copying files and directories"),
            FlagSpec::flag_short("dry-run", "n", "Show what would be executed"),
        ],
    },
    CommandSpec {
        name: "jump",
        description: "Jump to an existing worktree by branch name",
        positional_completion: Some(PositionalCompletion::WorktreeBranches),
        flags: &[],
    },
    CommandSpec {
        name: "rename",
        description: "Rename the current worktree's branch and directory",
        positional_completion: None,
        flags: &[FlagSpec::flag_short(
            "dry-run",
            "n",
            "Show what would be executed",
        )],
    },
    CommandSpec {
        name: "clean",
        description: "Remove current worktree and return to main",
        positional_completion: None,
        flags: &[
            FlagSpec::flag_short("force", "f", "Skip confirmation prompts"),
            FlagSpec::flag(
                "delete-branch",
                "Delete the branch after removing the worktree",
            ),
            FlagSpec::flag("keep-branch", "Keep the branch after removing the worktree"),
        ],
    },
    CommandSpec {
        name: "home",
        description: "Return to main worktree without removing current",
        positional_completion: None,
        flags: &[],
    },
    CommandSpec {
        name: "trust",
        description: "Trust .vibe.toml in current repository",
        positional_completion: None,
        flags: &[],
    },
    CommandSpec {
        name: "untrust",
        description: "Remove trust for .vibe.toml in current repository",
        positional_completion: None,
        flags: &[],
    },
    CommandSpec {
        name: "verify",
        description: "Verify trust status and hash history",
        positional_completion: None,
        flags: &[],
    },
    CommandSpec {
        name: "config",
        description: "Show current settings",
        positional_completion: None,
        flags: &[],
    },
    CommandSpec {
        name: "upgrade",
        description: "Check for updates and show upgrade instructions",
        positional_completion: None,
        flags: &[FlagSpec::flag(
            "check",
            "Check for updates without upgrade instructions",
        )],
    },
    CommandSpec {
        name: "shell-setup",
        description: "Print shell wrapper function for eval",
        positional_completion: None,
        flags: &[
            FlagSpec::value_candidates("shell", "Specify shell type", &SHELL_CANDIDATES),
            FlagSpec::flag(
                "with-completion",
                "Append shell autocompletion script to shell-setup output",
            ),
        ],
    },
];

/// Global flags (the TS `GLOBAL_FLAGS`).
pub const GLOBAL_FLAGS: &[FlagSpec] = &[
    FlagSpec::flag_short("help", "h", "Show help message"),
    FlagSpec::flag_short("version", "v", "Show version information"),
    FlagSpec::flag_short("verbose", "V", "Show detailed output"),
    FlagSpec::flag_short("quiet", "q", "Suppress non-essential output"),
];

/// Shell command emitting all local branch names (for `all-branches`).
pub const ALL_BRANCHES_CMD: &str =
    "git for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null";
