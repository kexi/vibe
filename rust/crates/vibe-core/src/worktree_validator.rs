//! Branch + worktree-path validation for `start`.
//!
//! Ported from `packages/core/src/services/worktree/validator.ts`. Pure logic
//! over a [`GitRunner`]: whether a branch can host a new worktree, and what kind
//! of conflict (if any) exists at a target path.

use crate::error::Result;
use crate::git::{
    branch_exists, find_worktree_by_branch, get_worktree_by_path, remote_branch_exists, GitRunner,
};

/// Result of validating a branch for worktree creation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchValidation {
    /// Whether the branch is valid for creating a worktree (false when already
    /// used by another worktree).
    pub is_valid: bool,
    /// Whether the branch exists in git (locally OR on `origin`).
    pub branch_exists: bool,
    /// If the branch is already in use, the path of that worktree.
    pub existing_worktree_path: Option<String>,
}

/// Kind of conflict at a target worktree path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictType {
    None,
    SameBranch,
    DifferentBranch,
}

/// Result of checking a target path for an existing worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeConflict {
    pub has_conflict: bool,
    pub conflict_type: ConflictType,
    pub existing_branch: Option<String>,
}

/// Validate `branch_name` for worktree creation.
///
/// If the branch is already used by a worktree → `is_valid: false` with that
/// path. Otherwise `is_valid: true`, with `branch_exists` = local OR origin.
pub fn validate_branch_for_worktree(
    git: &impl GitRunner,
    branch_name: &str,
) -> Result<BranchValidation> {
    let existing = find_worktree_by_branch(git, branch_name)?;
    if let Some(path) = existing {
        return Ok(BranchValidation {
            is_valid: false,
            branch_exists: true,
            existing_worktree_path: Some(path),
        });
    }

    let local = branch_exists(git, branch_name);
    let exists = local || remote_branch_exists(git, branch_name, "origin");
    Ok(BranchValidation {
        is_valid: true,
        branch_exists: exists,
        existing_worktree_path: None,
    })
}

/// Check the target path for an existing worktree and classify the conflict.
pub fn check_worktree_conflict(
    git: &impl GitRunner,
    target_path: &str,
    branch_name: &str,
) -> Result<WorktreeConflict> {
    let existing = get_worktree_by_path(git, target_path)?;
    let Some(wt) = existing else {
        return Ok(WorktreeConflict {
            has_conflict: false,
            conflict_type: ConflictType::None,
            existing_branch: None,
        });
    };

    if wt.branch == branch_name {
        return Ok(WorktreeConflict {
            has_conflict: false,
            conflict_type: ConflictType::SameBranch,
            existing_branch: Some(wt.branch),
        });
    }

    Ok(WorktreeConflict {
        has_conflict: true,
        conflict_type: ConflictType::DifferentBranch,
        existing_branch: Some(wt.branch),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::VibeError;
    use std::cell::RefCell;

    /// A scripted git: serves a worktree list, a set of existing local/remote
    /// branches, and records calls.
    struct MockGit {
        worktree_list: String,
        local_branches: Vec<String>,
        remote_branches: Vec<String>,
    }
    impl MockGit {
        fn new(worktree_list: &str) -> Self {
            MockGit {
                worktree_list: worktree_list.to_string(),
                local_branches: vec![],
                remote_branches: vec![],
            }
        }
        fn with_local(mut self, b: &str) -> Self {
            self.local_branches.push(b.to_string());
            self
        }
        fn with_remote(mut self, b: &str) -> Self {
            self.remote_branches.push(b.to_string());
            self
        }
    }
    impl GitRunner for MockGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            let _ = RefCell::new(()); // keep import warnings away in some builds
            if args.contains(&"list") && args.contains(&"worktree") {
                return Ok(self.worktree_list.clone());
            }
            if args.contains(&"show-ref") {
                // refs/heads/<b> for local; refs/remotes/origin/<b> for remote.
                let is_remote = args.iter().any(|a| a.contains("refs/remotes/"));
                let set = if is_remote {
                    &self.remote_branches
                } else {
                    &self.local_branches
                };
                let found = args
                    .iter()
                    .any(|a| set.iter().any(|b| a.ends_with(b.as_str())));
                return if found {
                    Ok(String::new())
                } else {
                    Err(VibeError::GitOperation {
                        command: args.join(" "),
                        message: "failed: no ref".into(),
                    })
                };
            }
            Ok(String::new())
        }
    }

    fn wt(main: &str, feat_path: &str, feat_branch: &str) -> String {
        format!("worktree {main}\nbranch refs/heads/main\n\nworktree {feat_path}\nbranch refs/heads/{feat_branch}\n\n")
    }

    #[test]
    fn branch_used_in_worktree_is_invalid_with_path() {
        let git = MockGit::new(&wt("/main", "/wt/feat", "feat"));
        let v = validate_branch_for_worktree(&git, "feat").unwrap();
        assert!(!v.is_valid);
        assert!(v.branch_exists);
        assert_eq!(v.existing_worktree_path.as_deref(), Some("/wt/feat"));
    }

    #[test]
    fn unused_local_branch_is_valid_and_exists() {
        let git = MockGit::new("worktree /main\nbranch refs/heads/main\n\n").with_local("dev");
        let v = validate_branch_for_worktree(&git, "dev").unwrap();
        assert!(v.is_valid);
        assert!(v.branch_exists);
        assert_eq!(v.existing_worktree_path, None);
    }

    #[test]
    fn unused_remote_only_branch_is_valid_and_exists() {
        let git = MockGit::new("worktree /main\nbranch refs/heads/main\n\n").with_remote("dev");
        let v = validate_branch_for_worktree(&git, "dev").unwrap();
        assert!(v.is_valid);
        assert!(v.branch_exists); // exists on origin.
    }

    #[test]
    fn brand_new_branch_is_valid_but_does_not_exist() {
        let git = MockGit::new("worktree /main\nbranch refs/heads/main\n\n");
        let v = validate_branch_for_worktree(&git, "brand-new").unwrap();
        assert!(v.is_valid);
        assert!(!v.branch_exists);
    }

    #[test]
    fn conflict_none_when_path_free() {
        let git = MockGit::new("worktree /main\nbranch refs/heads/main\n\n");
        let c = check_worktree_conflict(&git, "/wt/free", "feat").unwrap();
        assert_eq!(c.conflict_type, ConflictType::None);
        assert!(!c.has_conflict);
    }

    #[test]
    fn conflict_same_branch_is_not_a_hard_conflict() {
        let git = MockGit::new(&wt("/main", "/wt/feat", "feat"));
        let c = check_worktree_conflict(&git, "/wt/feat", "feat").unwrap();
        assert_eq!(c.conflict_type, ConflictType::SameBranch);
        assert!(!c.has_conflict);
        assert_eq!(c.existing_branch.as_deref(), Some("feat"));
    }

    #[test]
    fn conflict_different_branch_is_a_conflict() {
        let git = MockGit::new(&wt("/main", "/wt/feat", "other"));
        let c = check_worktree_conflict(&git, "/wt/feat", "feat").unwrap();
        assert_eq!(c.conflict_type, ConflictType::DifferentBranch);
        assert!(c.has_conflict);
        assert_eq!(c.existing_branch.as_deref(), Some("other"));
    }
}
