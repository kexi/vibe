//! clap CLI definition for vibe.
//!
//! Mirrors the flag surface declared in `packages/core/src/cli-args-options.ts`
//! and the per-command parsing in `main.ts`. Short flags are pinned to match the
//! original exactly: `-h` help, `-v` version, `-V` verbose, `-q` quiet, `-n`
//! dry-run, `-f` force. clap's automatic `-V`/`--version` is disabled because
//! the TS CLI uses `-V` for verbose and prints a custom multi-line version
//! block, which we handle ourselves.

use clap::{Args, Parser, Subcommand, ValueEnum};
use vibe_core::shell::EvalDialect;

#[derive(Debug, Parser)]
#[command(
    name = "vibe",
    about = "git worktree helper",
    disable_version_flag = true,
    disable_help_subcommand = true
)]
pub struct Cli {
    /// Show version information.
    #[arg(short = 'v', long = "version", global = true)]
    pub version: bool,

    /// Show detailed output.
    #[arg(short = 'V', long = "verbose", global = true)]
    pub verbose: bool,

    /// Suppress non-essential output.
    #[arg(short = 'q', long = "quiet", global = true)]
    pub quiet: bool,

    /// Internal: stdout dialect requested by the shell wrapper.
    #[arg(long = "eval-dialect", global = true, hide = true, value_enum)]
    pub eval_dialect: Option<EvalDialectArg>,

    #[command(subcommand)]
    pub command: Option<Command>,
}

/// clap mirror of [`EvalDialect`].
///
/// Why not derive `ValueEnum` on `vibe_core::shell::EvalDialect` directly:
/// vibe-core has no clap dependency and must stay CLI-framework free, so the
/// parsing surface lives in the binary and converts across the boundary.
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum EvalDialectArg {
    Posix,
    #[value(alias = "nushell")]
    Nu,
    #[value(alias = "pwsh")]
    Powershell,
}

impl From<EvalDialectArg> for EvalDialect {
    fn from(value: EvalDialectArg) -> Self {
        match value {
            EvalDialectArg::Posix => EvalDialect::Posix,
            EvalDialectArg::Nu => EvalDialect::Nushell,
            EvalDialectArg::Powershell => EvalDialect::Powershell,
        }
    }
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Create a new worktree with the given branch.
    Start(StartArgs),
    /// Create a worktree with an auto-generated scratch/<timestamp> name.
    Scratch(ScratchArgs),
    /// Jump to an existing worktree by branch name.
    Jump(JumpArgs),
    /// Rename the current worktree's branch and directory.
    Rename(RenameArgs),
    /// Remove current worktree and return to main.
    Clean(CleanArgs),
    /// Return to main worktree without removing current.
    Home,
    /// Trust .vibe.toml in current repository.
    Trust,
    /// Remove trust for .vibe.toml in current repository.
    Untrust,
    /// Verify trust status and hash history.
    Verify,
    /// Show current settings.
    Config,
    /// Check for updates and show upgrade instructions.
    Upgrade(UpgradeArgs),
    /// Check the environment for problems (stale nushell/PowerShell wrappers).
    Doctor,
    /// Print shell wrapper function for eval.
    #[command(name = "shell-setup")]
    ShellSetup(ShellSetupArgs),
}

#[derive(Debug, Args)]
pub struct StartArgs {
    /// Branch name for the new worktree.
    pub branch_name: Option<String>,
    /// Use existing branch instead of creating a new one.
    #[arg(long)]
    pub reuse: bool,
    /// Skip pre-start and post-start hooks.
    #[arg(long = "no-hooks")]
    pub no_hooks: bool,
    /// Skip file/directory copying.
    #[arg(long = "no-copy")]
    pub no_copy: bool,
    /// Show what would happen without doing it.
    #[arg(short = 'n', long = "dry-run")]
    pub dry_run: bool,
    /// Skip confirmation prompts.
    #[arg(short = 'f', long)]
    pub force: bool,
    /// Base branch/commit for the new branch.
    #[arg(long)]
    pub base: Option<String>,
    /// Set upstream tracking when using --base.
    #[arg(long)]
    pub track: bool,
    /// Claude Code worktree-hook mode (reads JSON from stdin).
    #[arg(long = "claude-code-worktree-hook")]
    pub worktree_hook: bool,
}

#[derive(Debug, Args)]
pub struct ScratchArgs {
    #[arg(long)]
    pub reuse: bool,
    #[arg(long = "no-hooks")]
    pub no_hooks: bool,
    #[arg(long = "no-copy")]
    pub no_copy: bool,
    #[arg(short = 'n', long = "dry-run")]
    pub dry_run: bool,
    #[arg(long)]
    pub base: Option<String>,
    #[arg(long)]
    pub track: bool,
}

#[derive(Debug, Args)]
pub struct JumpArgs {
    /// Branch name (or partial/fuzzy match) of the worktree to jump to.
    pub branch_name: Option<String>,
}

#[derive(Debug, Args)]
pub struct RenameArgs {
    /// New branch/worktree name.
    pub new_name: Option<String>,
    #[arg(short = 'n', long = "dry-run")]
    pub dry_run: bool,
    /// Allow operating on the repository's default branch.
    #[arg(long = "allow-default-branch")]
    pub allow_default_branch: bool,
}

#[derive(Debug, Args)]
pub struct CleanArgs {
    /// Skip the uncommitted-changes confirmation.
    #[arg(short = 'f', long)]
    pub force: bool,
    /// Delete the branch after removing the worktree.
    #[arg(long = "delete-branch")]
    pub delete_branch: bool,
    /// Keep the branch after removing the worktree.
    #[arg(long = "keep-branch")]
    pub keep_branch: bool,
    /// Allow operating on the repository's default branch.
    #[arg(long = "allow-default-branch")]
    pub allow_default_branch: bool,
    /// Claude Code worktree-hook mode (reads JSON from stdin).
    #[arg(long = "claude-code-worktree-hook")]
    pub worktree_hook: bool,
}

#[derive(Debug, Args)]
pub struct UpgradeArgs {
    /// Only report whether an update is available.
    #[arg(long)]
    pub check: bool,
}

#[derive(Debug, Args)]
pub struct ShellSetupArgs {
    /// Target shell (bash, zsh, fish, nushell, powershell). Defaults to $SHELL.
    #[arg(long)]
    pub shell: Option<String>,
    /// Append shell completion script.
    #[arg(long = "with-completion")]
    pub with_completion: bool,
}

/// clap ↔ completion-spec consistency.
///
/// Ported from `packages/core/src/commands/cli-flags-consistency.test.ts`. The
/// TS cross-checked `parseArgsOptions` against `completion-spec.ts`; here we walk
/// the clap `Cli` definition and assert it agrees with
/// `vibe_core::completion::{SUBCOMMANDS, GLOBAL_FLAGS}`.
///
/// Two layers of checks:
/// - The *global pool* checks (`every_clap_flag_*`, `every_completion_flag_*`,
///   `short_aliases_agree`) compare the union of all flag names across every
///   subcommand. They catch a flag that exists on one side but nowhere on the
///   other, but — because they pool names — they CANNOT catch a per-subcommand
///   omission (e.g. a flag declared for `start` in the spec but only present on
///   `clean` in clap). They do not guarantee completions never go stale.
/// - `per_subcommand_flags_match` closes that gap: it compares each subcommand's
///   clap flags against that same subcommand's completion-spec entry, so a
///   per-subcommand drift (the `start --force` mismatch this test now guards) is
///   caught.
#[cfg(test)]
mod consistency_tests {
    use super::Cli;
    use clap::CommandFactory;
    use std::collections::{BTreeMap, BTreeSet};
    use vibe_core::completion::{GLOBAL_FLAGS, SUBCOMMANDS};

    /// Internal flags intentionally excluded from the completion spec.
    const INTERNAL_FLAGS_NOT_EXPOSED: &[&str] = &["claude-code-worktree-hook", "eval-dialect"];

    /// Long flag names that are clap-`global` (so they appear under every
    /// subcommand's `get_arguments()`) but are modeled once as GLOBAL_FLAGS in
    /// the spec, not repeated per subcommand. Excluded from the per-subcommand
    /// comparison so they don't read as spurious extra clap flags.
    const GLOBAL_LONGS: &[&str] = &["version", "verbose", "quiet", "help"];

    /// Per-subcommand local (non-global, non-internal) long flags declared in
    /// the completion spec, keyed by subcommand name.
    fn spec_subcommand_flags() -> BTreeMap<String, BTreeSet<String>> {
        let mut map = BTreeMap::new();
        for c in SUBCOMMANDS {
            let flags: BTreeSet<String> = c.flags.iter().map(|f| f.long.to_string()).collect();
            map.insert(c.name.to_string(), flags);
        }
        map
    }

    /// Per-subcommand local long flags declared in clap, keyed by subcommand
    /// name (global + internal-only flags removed so it lines up with the spec).
    fn clap_subcommand_flags() -> BTreeMap<String, BTreeSet<String>> {
        let cmd = Cli::command();
        let mut map = BTreeMap::new();
        for sub in cmd.get_subcommands() {
            let flags: BTreeSet<String> = sub
                .get_arguments()
                .filter_map(|a| a.get_long())
                .map(|l| l.to_string())
                .filter(|l| !GLOBAL_LONGS.contains(&l.as_str()))
                .filter(|l| !INTERNAL_FLAGS_NOT_EXPOSED.contains(&l.as_str()))
                .collect();
            map.insert(sub.get_name().to_string(), flags);
        }
        map
    }

    fn completion_long_flags() -> BTreeSet<String> {
        let mut set = BTreeSet::new();
        for f in GLOBAL_FLAGS {
            set.insert(f.long.to_string());
        }
        for c in SUBCOMMANDS {
            for f in c.flags {
                set.insert(f.long.to_string());
            }
        }
        set
    }

    fn completion_shorts() -> BTreeMap<String, String> {
        let mut map = BTreeMap::new();
        let mut add = |f: &vibe_core::completion::FlagSpec| {
            if let Some(s) = f.short {
                map.insert(f.long.to_string(), s.to_string());
            }
        };
        for f in GLOBAL_FLAGS {
            add(f);
        }
        for c in SUBCOMMANDS {
            for f in c.flags {
                add(f);
            }
        }
        map
    }

    fn clap_flags() -> (BTreeSet<String>, BTreeMap<String, String>) {
        let cmd = Cli::command();
        let mut longs = BTreeSet::new();
        let mut shorts = BTreeMap::new();

        let mut collect = |arg: &clap::Arg| {
            let Some(long) = arg.get_long() else {
                return;
            };
            longs.insert(long.to_string());
            if let Some(short) = arg.get_short() {
                shorts.insert(long.to_string(), short.to_string());
            }
        };

        for arg in cmd.get_arguments() {
            collect(arg);
        }
        for sub in cmd.get_subcommands() {
            for arg in sub.get_arguments() {
                collect(arg);
            }
        }

        // clap auto-generates `-h/--help` as a built-in action, so it is not in
        // `get_arguments()`. The completion spec lists it as a GLOBAL_FLAG, so
        // inject it here to keep the cross-check honest (it is genuinely part of
        // the clap surface — `vibe --help` works).
        longs.insert("help".to_string());
        shorts.insert("help".to_string(), "h".to_string());

        (longs, shorts)
    }

    #[test]
    fn every_clap_flag_is_in_completion_spec_or_internal() {
        let (clap_longs, _) = clap_flags();
        let completion = completion_long_flags();
        let missing: Vec<&String> = clap_longs
            .iter()
            // `help` is clap-generated per subcommand but is already a GLOBAL_FLAG.
            .filter(|k| k.as_str() != "help")
            .filter(|k| {
                !completion.contains(*k) && !INTERNAL_FLAGS_NOT_EXPOSED.contains(&k.as_str())
            })
            .collect();
        assert!(
            missing.is_empty(),
            "clap flags missing from completion: {missing:?}"
        );
    }

    #[test]
    fn every_completion_flag_is_defined_in_clap() {
        let (clap_longs, _) = clap_flags();
        let orphan: Vec<String> = completion_long_flags()
            .into_iter()
            .filter(|k| !clap_longs.contains(k))
            .collect();
        assert!(
            orphan.is_empty(),
            "completion flags not in clap: {orphan:?}"
        );
    }

    #[test]
    fn short_aliases_agree() {
        let (_, clap_shorts) = clap_flags();
        for (long, short) in completion_shorts() {
            assert_eq!(
                clap_shorts.get(&long),
                Some(&short),
                "short alias mismatch for --{long}"
            );
        }
    }

    #[test]
    fn internal_allowlist_has_no_dead_entries() {
        let (clap_longs, _) = clap_flags();
        let dead: Vec<&&str> = INTERNAL_FLAGS_NOT_EXPOSED
            .iter()
            .filter(|k| !clap_longs.contains(**k))
            .collect();
        assert!(dead.is_empty(), "dead internal-flag allowlist: {dead:?}");
    }

    /// Drift guard for the `--eval-dialect` vocabulary.
    ///
    /// `vibe doctor` decides whether a pasted wrapper is current by matching the
    /// dialect value in the wrapper's text against
    /// `EvalDialect::accepted_values()`. If clap gained an alias that list did not
    /// know about, every user of the new spelling would be told their correct
    /// wrapper is stale — so the two vocabularies must stay identical.
    #[test]
    fn eval_dialect_spellings_match_the_core_vocabulary() {
        use clap::ValueEnum;
        use std::collections::BTreeSet;
        use vibe_core::shell::EvalDialect;

        for variant in super::EvalDialectArg::value_variants() {
            let value = variant
                .to_possible_value()
                .expect("every dialect variant is selectable");
            let clap_spellings: BTreeSet<&str> = std::iter::once(value.get_name())
                .chain(value.get_name_and_aliases())
                .collect();
            let core_spellings: BTreeSet<&str> = EvalDialect::from(*variant)
                .accepted_values()
                .iter()
                .copied()
                .collect();
            assert_eq!(
                clap_spellings, core_spellings,
                "--eval-dialect spellings drifted for {variant:?}"
            );
        }
    }

    /// Per-subcommand cross-check: each subcommand's clap flags must exactly
    /// match that subcommand's completion-spec flags. Unlike the global-pool
    /// checks above, this catches a flag present on the wrong subcommand (the
    /// `start --force` drift a reviewer flagged: spec had it, clap did not).
    #[test]
    fn per_subcommand_flags_match() {
        let spec = spec_subcommand_flags();
        let clap = clap_subcommand_flags();

        // Same set of subcommand names on both sides.
        let spec_names: BTreeSet<&String> = spec.keys().collect();
        let clap_names: BTreeSet<&String> = clap.keys().collect();
        assert_eq!(
            spec_names, clap_names,
            "subcommand sets differ between spec and clap"
        );

        for (name, spec_flags) in &spec {
            let clap_flags = clap.get(name).expect("checked above");
            assert_eq!(
                spec_flags, clap_flags,
                "flag set mismatch for subcommand `{name}`: spec={spec_flags:?} clap={clap_flags:?}"
            );
        }
    }
}
