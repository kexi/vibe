//! Git worktree create/remove operations.
//!
//! Ported from `packages/core/src/services/worktree/operations.ts`, HARDENED
//! with a `--` separator before all positional path/ref args (security #3,
//! git-flag injection): an attacker-influenced path or branch can never be
//! parsed as a git option. The `-b <branch>` value legitimately stays BEFORE
//! `--` (it is an option value, not a positional); the leading-dash reject on a
//! stdin-sourced name (see `stdin.rs`) guards that slot.

use crate::error::{Result, VibeError};
use crate::git::GitRunner;

/// Options for creating a worktree.
pub struct CreateWorktreeOptions<'a> {
    pub branch_name: &'a str,
    pub worktree_path: &'a str,
    /// Whether the branch already exists (false → create a new branch with `-b`).
    pub branch_exists: bool,
    /// Optional base ref when creating a NEW branch.
    pub base_ref: Option<&'a str>,
    /// Whether to set upstream tracking when using `base_ref`.
    pub track: bool,
}

/// Create a git worktree.
///
/// argv shapes (note the `--` before positionals):
/// - existing branch: `worktree add -- <path> <branch>`
/// - new branch + base: `worktree add -b <branch> <track_flag> -- <path> <base>`
/// - new branch: `worktree add -b <branch> -- <path>`
pub fn create_worktree(git: &impl GitRunner, opts: &CreateWorktreeOptions) -> Result<()> {
    if opts.branch_exists {
        git.run(&[
            "worktree",
            "add",
            "--",
            opts.worktree_path,
            opts.branch_name,
        ])?;
        return Ok(());
    }

    if let Some(base) = opts.base_ref {
        let track_flag = if opts.track { "--track" } else { "--no-track" };
        git.run(&[
            "worktree",
            "add",
            "-b",
            opts.branch_name,
            track_flag,
            "--",
            opts.worktree_path,
            base,
        ])?;
        return Ok(());
    }

    git.run(&[
        "worktree",
        "add",
        "-b",
        opts.branch_name,
        "--",
        opts.worktree_path,
    ])?;
    Ok(())
}

/// Remove a git worktree: `worktree remove [--force] -- <path>`.
pub fn remove_worktree(git: &impl GitRunner, worktree_path: &str, force: bool) -> Result<()> {
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push("--");
    args.push(worktree_path);
    git.run(&args)?;
    Ok(())
}

/// The git command that WOULD run to create a worktree, for dry-run logging.
///
/// The path is single-quoted (TS parity); the `--` separator is shown so the
/// dry-run output matches what is actually executed.
pub fn get_create_worktree_command(opts: &CreateWorktreeOptions) -> String {
    if opts.branch_exists {
        return format!(
            "git worktree add -- '{}' {}",
            opts.worktree_path, opts.branch_name
        );
    }
    if let Some(base) = opts.base_ref {
        let track_flag = if opts.track { "--track" } else { "--no-track" };
        return format!(
            "git worktree add -b {} {} -- '{}' {}",
            opts.branch_name, track_flag, opts.worktree_path, base
        );
    }
    format!(
        "git worktree add -b {} -- '{}'",
        opts.branch_name, opts.worktree_path
    )
}

/// Map a git error from `create_worktree` to a `Worktree` error variant when it
/// is more appropriate; default is to pass the `GitOperation` through.
pub fn worktree_error(message: impl Into<String>) -> VibeError {
    VibeError::Worktree(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct MockGit {
        calls: RefCell<Vec<Vec<String>>>,
    }
    impl MockGit {
        fn new() -> Self {
            MockGit {
                calls: RefCell::new(vec![]),
            }
        }
        fn last(&self) -> Vec<String> {
            self.calls.borrow().last().cloned().unwrap()
        }
    }
    impl GitRunner for MockGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            self.calls
                .borrow_mut()
                .push(args.iter().map(|s| s.to_string()).collect());
            Ok(String::new())
        }
    }

    // --- SECURITY #3: `--` separator before positional path/ref ---

    #[test]
    fn create_existing_branch_inserts_double_dash_before_path() {
        let git = MockGit::new();
        create_worktree(
            &git,
            &CreateWorktreeOptions {
                branch_name: "feat",
                worktree_path: "/wt/feat",
                branch_exists: true,
                base_ref: None,
                track: false,
            },
        )
        .unwrap();
        assert_eq!(
            git.last(),
            vec!["worktree", "add", "--", "/wt/feat", "feat"]
        );
    }

    #[test]
    fn create_new_branch_inserts_double_dash() {
        let git = MockGit::new();
        create_worktree(
            &git,
            &CreateWorktreeOptions {
                branch_name: "feat",
                worktree_path: "/wt/feat",
                branch_exists: false,
                base_ref: None,
                track: false,
            },
        )
        .unwrap();
        assert_eq!(
            git.last(),
            vec!["worktree", "add", "-b", "feat", "--", "/wt/feat"]
        );
    }

    #[test]
    fn create_new_branch_with_base_and_track() {
        let git = MockGit::new();
        create_worktree(
            &git,
            &CreateWorktreeOptions {
                branch_name: "feat",
                worktree_path: "/wt/feat",
                branch_exists: false,
                base_ref: Some("main"),
                track: true,
            },
        )
        .unwrap();
        // -b <branch> --track BEFORE --, then -- <path> <base>.
        assert_eq!(
            git.last(),
            vec!["worktree", "add", "-b", "feat", "--track", "--", "/wt/feat", "main"]
        );
    }

    #[test]
    fn create_new_branch_with_base_no_track_uses_no_track_flag() {
        let git = MockGit::new();
        create_worktree(
            &git,
            &CreateWorktreeOptions {
                branch_name: "feat",
                worktree_path: "/wt/feat",
                branch_exists: false,
                base_ref: Some("origin/main"),
                track: false,
            },
        )
        .unwrap();
        assert_eq!(
            git.last(),
            vec![
                "worktree",
                "add",
                "-b",
                "feat",
                "--no-track",
                "--",
                "/wt/feat",
                "origin/main"
            ]
        );
    }

    #[test]
    fn remove_worktree_inserts_double_dash() {
        let git = MockGit::new();
        remove_worktree(&git, "/wt/feat", false).unwrap();
        assert_eq!(git.last(), vec!["worktree", "remove", "--", "/wt/feat"]);
    }

    #[test]
    fn remove_worktree_force_inserts_force_then_double_dash() {
        let git = MockGit::new();
        remove_worktree(&git, "/wt/feat", true).unwrap();
        assert_eq!(
            git.last(),
            vec!["worktree", "remove", "--force", "--", "/wt/feat"]
        );
    }

    // --- dry-run command strings include `--` ---

    #[test]
    fn dry_run_strings_quote_path_and_include_double_dash() {
        let existing = get_create_worktree_command(&CreateWorktreeOptions {
            branch_name: "feat",
            worktree_path: "/wt/feat",
            branch_exists: true,
            base_ref: None,
            track: false,
        });
        assert_eq!(existing, "git worktree add -- '/wt/feat' feat");

        let new = get_create_worktree_command(&CreateWorktreeOptions {
            branch_name: "feat",
            worktree_path: "/wt/feat",
            branch_exists: false,
            base_ref: None,
            track: false,
        });
        assert_eq!(new, "git worktree add -b feat -- '/wt/feat'");

        let with_base = get_create_worktree_command(&CreateWorktreeOptions {
            branch_name: "feat",
            worktree_path: "/wt/feat",
            branch_exists: false,
            base_ref: Some("main"),
            track: true,
        });
        assert_eq!(
            with_base,
            "git worktree add -b feat --track -- '/wt/feat' main"
        );
    }
}
