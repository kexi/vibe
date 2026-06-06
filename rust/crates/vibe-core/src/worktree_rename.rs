//! Git operations for `vibe rename`.
//!
//! Ported from `packages/core/src/services/worktree/rename.ts`. Provides the
//! three git actions the rename command needs — moving a worktree directory,
//! renaming a branch, detecting whether a branch tracks a remote — plus the
//! dry-run textual forms of the mutating commands. All git access goes through
//! the injected [`GitRunner`] so the command stays unit-testable.

use crate::error::Result;
use crate::git::GitRunner;

/// Result of upstream detection for a branch.
///
/// - `None`            → no upstream configured
/// - `Local`           → local-tracking branch (`branch.<name>.remote = "."`)
/// - `Remote(name)`    → tracking a remote (i.e. likely pushed)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BranchUpstream {
    None,
    Local,
    Remote(String),
}

/// Detect the upstream remote of `branch`.
///
/// Reads `branch.<name>.remote` from git config. A missing key (git exits 1)
/// is treated as [`BranchUpstream::None`], matching the TS try/catch. A trimmed
/// empty value is also `None`; `"."` is [`BranchUpstream::Local`]; anything else
/// is [`BranchUpstream::Remote`].
pub fn get_branch_upstream(runner: &impl GitRunner, branch: &str) -> Result<BranchUpstream> {
    let key = format!("branch.{branch}.remote");
    let value = match runner.run(&["config", "--get", &key]) {
        Ok(v) => v,
        Err(_) => return Ok(BranchUpstream::None), // key missing → none
    };

    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(BranchUpstream::None);
    }
    if trimmed == "." {
        return Ok(BranchUpstream::Local);
    }
    Ok(BranchUpstream::Remote(trimmed.to_string()))
}

/// Move a worktree directory: `git worktree move <old> <new>`.
///
/// git updates the worktree's `.git/worktrees/<name>` metadata for us.
pub fn move_worktree(runner: &impl GitRunner, old: &str, new: &str) -> Result<()> {
    runner.run(&["worktree", "move", old, new]).map(|_| ())
}

/// Rename a branch: `git branch -m <old> <new>`.
pub fn rename_branch(runner: &impl GitRunner, old: &str, new: &str) -> Result<()> {
    runner.run(&["branch", "-m", old, new]).map(|_| ())
}

/// Dry-run textual form of the worktree move command (single-quoted paths).
pub fn get_move_worktree_command(old: &str, new: &str) -> String {
    format!("git worktree move '{old}' '{new}'")
}

/// Dry-run textual form of the branch rename command.
pub fn get_rename_branch_command(old: &str, new: &str) -> String {
    format!("git branch -m {old} {new}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::VibeError;
    use std::cell::RefCell;

    /// Git scripted by exact arg-vector match, recording every call.
    struct ScriptGit {
        /// `branch.<name>.remote` config value; `None` → the key is missing.
        remote: Option<String>,
        calls: RefCell<Vec<Vec<String>>>,
    }
    impl ScriptGit {
        fn new(remote: Option<&str>) -> Self {
            ScriptGit {
                remote: remote.map(|s| s.to_string()),
                calls: RefCell::new(vec![]),
            }
        }
    }
    impl GitRunner for ScriptGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            self.calls
                .borrow_mut()
                .push(args.iter().map(|s| s.to_string()).collect());
            if args.contains(&"--get") {
                return match &self.remote {
                    Some(v) => Ok(v.clone()),
                    None => Err(VibeError::GitOperation {
                        command: args.join(" "),
                        message: "failed: key does not exist".into(),
                    }),
                };
            }
            Ok(String::new())
        }
    }

    #[test]
    fn upstream_none_when_config_key_missing() {
        let git = ScriptGit::new(None);
        assert_eq!(
            get_branch_upstream(&git, "feat").unwrap(),
            BranchUpstream::None
        );
    }

    #[test]
    fn upstream_none_when_value_empty() {
        let git = ScriptGit::new(Some("   "));
        assert_eq!(
            get_branch_upstream(&git, "feat").unwrap(),
            BranchUpstream::None
        );
    }

    #[test]
    fn upstream_local_for_dot() {
        let git = ScriptGit::new(Some("."));
        assert_eq!(
            get_branch_upstream(&git, "feat").unwrap(),
            BranchUpstream::Local
        );
    }

    #[test]
    fn upstream_remote_for_named_remote() {
        let git = ScriptGit::new(Some("origin\n"));
        assert_eq!(
            get_branch_upstream(&git, "feat").unwrap(),
            BranchUpstream::Remote("origin".into())
        );
    }

    #[test]
    fn move_worktree_issues_expected_args() {
        let git = ScriptGit::new(None);
        move_worktree(&git, "/old", "/new").unwrap();
        assert_eq!(
            git.calls.borrow()[0],
            vec!["worktree", "move", "/old", "/new"]
        );
    }

    #[test]
    fn rename_branch_issues_expected_args() {
        let git = ScriptGit::new(None);
        rename_branch(&git, "old", "new").unwrap();
        assert_eq!(git.calls.borrow()[0], vec!["branch", "-m", "old", "new"]);
    }

    #[test]
    fn dry_run_command_strings() {
        assert_eq!(
            get_move_worktree_command("/a b", "/c d"),
            "git worktree move '/a b' '/c d'"
        );
        assert_eq!(
            get_rename_branch_command("old", "new"),
            "git branch -m old new"
        );
    }
}
