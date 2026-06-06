//! Git operations and porcelain parsing.
//!
//! Ported from `packages/core/src/utils/git.ts`. The original threaded an
//! `AppContext` so tests could mock `process.run`/`fs`; here a [`GitRunner`]
//! trait plays that role. Pure helpers (`sanitize_branch_name`,
//! `normalize_remote_url`, worktree-list parsing) take no runner and are tested
//! directly. [`RealGit`] is the production runner over `std::process::Command`.

use crate::error::{Result, VibeError};
use std::path::Path;
use std::process::Command;

/// A single worktree entry parsed from `git worktree list --porcelain`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub path: String,
    pub branch: String,
}

/// Repository information extracted from a file path.
///
/// Ported from the `RepoInfo` interface in git.ts. Used by the trust store to
/// identify which repository a `.vibe.toml` belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoInfo {
    pub remote_url: Option<String>,
    pub repo_root: String,
    pub relative_path: String,
}

/// Abstraction over running `git`, so command-driven logic is unit-testable.
///
/// Mirrors the role of the mocked `process.run` in the TS tests. `run` returns
/// trimmed stdout on success and a [`VibeError::GitOperation`] on failure.
pub trait GitRunner {
    fn run(&self, args: &[&str]) -> Result<String>;
}

/// Production [`GitRunner`] that shells out to the real `git` binary.
pub struct RealGit;

impl GitRunner for RealGit {
    fn run(&self, args: &[&str]) -> Result<String> {
        let output =
            Command::new("git")
                .args(args)
                .output()
                .map_err(|e| VibeError::GitOperation {
                    command: args.join(" "),
                    message: e.to_string(),
                })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Matches the TS message: `git <args> failed: <stderr>`.
            return Err(VibeError::GitOperation {
                command: args.join(" "),
                message: format!("failed: {}", stderr.trim()),
            });
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
}

/// Replace `/` with `-` in a branch name (for default worktree dir names).
pub fn sanitize_branch_name(branch_name: &str) -> String {
    branch_name.replace('/', "-")
}

/// Parse `git worktree list --porcelain` output into ordered worktree entries.
///
/// git emits entries in a stable order (main worktree first), so we preserve
/// the emitted order rather than re-sorting — and we never depend on
/// nondeterministic filesystem `read_dir` order anywhere.
pub fn parse_worktree_list(output: &str) -> Vec<Worktree> {
    let mut worktrees = Vec::new();
    let mut current_path = String::new();

    for line in output.split('\n') {
        if let Some(rest) = line.strip_prefix("worktree ") {
            current_path = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("branch refs/heads/") {
            worktrees.push(Worktree {
                path: current_path.clone(),
                branch: rest.to_string(),
            });
        }
    }

    worktrees
}

/// Normalize a git remote URL to a canonical `host/user/repo` form.
///
/// Direct port of `normalizeRemoteUrl`: strip trailing `.git`, convert
/// `git@host:path` to `host/path`, strip the protocol, then strip credentials.
pub fn normalize_remote_url(url: &str) -> String {
    let mut normalized = url.trim().to_string();

    // Remove trailing `.git`.
    if let Some(stripped) = normalized.strip_suffix(".git") {
        normalized = stripped.to_string();
    }

    // Convert SSH `git@host:` prefix to `host/`.
    normalized = convert_scp_prefix(&normalized);

    // Remove protocol (`https://`, `http://`, `ssh://`, ...).
    normalized = strip_protocol(&normalized);

    // Remove leading credentials (`user@` or `user:pass@`) up to the first `@`.
    if let Some(at) = normalized.find('@') {
        normalized = normalized[at + 1..].to_string();
    }

    normalized
}

/// Convert a leading `git@host:` (scp-like) prefix to `host/`.
///
/// Matches the TS regex `^git@([^:]+):` → `$1/`.
fn convert_scp_prefix(s: &str) -> String {
    let Some(rest) = s.strip_prefix("git@") else {
        return s.to_string();
    };
    let Some(colon) = rest.find(':') else {
        return s.to_string();
    };
    let host = &rest[..colon];
    // `[^:]+` means the host portion must not contain a colon, which holds here
    // since we split on the first colon.
    format!("{host}/{}", &rest[colon + 1..])
}

/// Strip a leading `<scheme>://` where scheme is lowercase letters.
///
/// Matches the TS regex `^[a-z]+:\/\/`.
fn strip_protocol(s: &str) -> String {
    let Some(idx) = s.find("://") else {
        return s.to_string();
    };
    let scheme = &s[..idx];
    if !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_lowercase()) {
        s[idx + 3..].to_string()
    } else {
        s.to_string()
    }
}

/// Find the worktree path using `branch_name`, or `None`.
pub fn find_worktree_by_branch(
    runner: &impl GitRunner,
    branch_name: &str,
) -> Result<Option<String>> {
    let output = runner.run(&["worktree", "list", "--porcelain"])?;
    let worktrees = parse_worktree_list(&output);
    Ok(worktrees
        .into_iter()
        .find(|w| w.branch == branch_name)
        .map(|w| w.path))
}

/// Find the worktree whose path lexically normalizes to `path`, or `None`.
///
/// Ported from `getWorktreeByPath`. Matching is LEXICAL (node `path.normalize`):
/// it folds `.`/`..`/duplicate separators textually but does NOT touch the
/// filesystem or resolve symlinks. We deliberately do NOT `canonicalize` here so
/// the result matches the TS even when the directory has just been moved out from
/// under us (e.g. mid-rename) — a `canonicalize` would fail on a vanished path.
pub fn get_worktree_by_path(runner: &impl GitRunner, path: &str) -> Result<Option<Worktree>> {
    let worktrees = get_worktree_list(runner)?;
    let target = lexical_normalize_path(path);
    Ok(worktrees
        .into_iter()
        .find(|w| lexical_normalize_path(&w.path) == target))
}

/// Lexically fold a path (`.`/`..`/redundant separators) WITHOUT filesystem
/// access, approximating node's `path.normalize` closely enough for worktree
/// path equality. `Path::components` already drops `.` and collapses separators;
/// we additionally pop on `..` to fold parent traversals.
pub fn lexical_normalize_path(path: &str) -> String {
    use std::path::Component;
    let mut stack: Vec<std::ffi::OsString> = Vec::new();
    let mut prefix = String::new();
    let mut is_absolute = false;
    for comp in Path::new(path).components() {
        match comp {
            Component::Prefix(p) => prefix = p.as_os_str().to_string_lossy().into_owned(),
            Component::RootDir => is_absolute = true,
            Component::CurDir => {}
            Component::ParentDir => {
                // Pop a normal segment if present; otherwise keep `..` (it can
                // only stay when the path is relative and has no parent to fold).
                let can_pop = stack
                    .last()
                    .map(|s| s != std::ffi::OsStr::new(".."))
                    .unwrap_or(false);
                if can_pop {
                    stack.pop();
                } else if !is_absolute {
                    stack.push(std::ffi::OsString::from(".."));
                }
            }
            Component::Normal(seg) => stack.push(seg.to_os_string()),
        }
    }
    let joined = stack
        .iter()
        .map(|s| s.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    let body = if is_absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    };
    format!("{prefix}{body}")
}

/// `git rev-parse --show-toplevel`.
pub fn get_repo_root(runner: &impl GitRunner) -> Result<String> {
    runner.run(&["rev-parse", "--show-toplevel"])
}

/// The repository name: the basename of the repo root (TS `getRepoName`).
pub fn get_repo_name(runner: &impl GitRunner) -> Result<String> {
    let root = get_repo_root(runner)?;
    Ok(std::path::Path::new(&root)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or(root))
}

/// True if `ref` resolves (`git rev-parse --verify --quiet <ref>`). Any failure
/// → `false` (TS `revisionExists` try/catch).
pub fn revision_exists(runner: &impl GitRunner, reference: &str) -> bool {
    runner
        .run(&["rev-parse", "--verify", "--quiet", reference])
        .is_ok()
}

/// True if `refs/remotes/<remote>/<branch>` exists (TS `remoteBranchExists`).
pub fn remote_branch_exists(runner: &impl GitRunner, branch_name: &str, remote: &str) -> bool {
    runner
        .run(&[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{remote}/{branch_name}"),
        ])
        .is_ok()
}

/// All worktrees from `git worktree list --porcelain`, in git's emitted order.
pub fn get_worktree_list(runner: &impl GitRunner) -> Result<Vec<Worktree>> {
    let output = runner.run(&["worktree", "list", "--porcelain"])?;
    Ok(parse_worktree_list(&output))
}

/// True iff `git rev-parse --is-inside-work-tree` prints `true`.
///
/// Any git failure (not a repo) maps to `false`, matching the TS try/catch.
pub fn is_inside_worktree(runner: &impl GitRunner) -> bool {
    runner
        .run(&["rev-parse", "--is-inside-work-tree"])
        .map(|out| out == "true")
        .unwrap_or(false)
}

/// The main worktree's path: the first entry of `git worktree list`.
///
/// Errors if no worktree is listed (TS threw "Could not find main worktree").
pub fn get_main_worktree_path(runner: &impl GitRunner) -> Result<String> {
    let worktrees = get_worktree_list(runner)?;
    worktrees
        .into_iter()
        .next()
        .map(|w| w.path)
        .ok_or_else(|| VibeError::Worktree("Could not find main worktree".to_string()))
}

/// Whether the current repo root is the main worktree.
pub fn is_main_worktree(runner: &impl GitRunner) -> Result<bool> {
    let current_root = get_repo_root(runner)?;
    let main_path = get_main_worktree_path(runner)?;
    Ok(current_root == main_path)
}

/// True if `git status --porcelain` reports any change (or untracked file).
pub fn has_uncommitted_changes(runner: &impl GitRunner) -> Result<bool> {
    let output = runner.run(&["status", "--porcelain"])?;
    Ok(!output.trim().is_empty())
}

/// True if `refs/heads/<branch>` exists locally.
pub fn branch_exists(runner: &impl GitRunner, branch_name: &str) -> bool {
    runner
        .run(&[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch_name}"),
        ])
        .is_ok()
}

/// Result of [`detect_broken_worktree_link`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BrokenWorktreeLink {
    pub is_broken: bool,
    pub git_dir: Option<String>,
    pub main_worktree_path: Option<String>,
}

/// Detect a secondary worktree whose main worktree (and thus `.git` gitdir
/// target) has been deleted, leaving a dangling `.git` file.
///
/// Ported from `detectBrokenWorktreeLink`. `cwd` is passed in (the TS read it
/// from the runtime) so this stays a pure function over the filesystem.
pub fn detect_broken_worktree_link(cwd: &Path) -> BrokenWorktreeLink {
    let not_broken = BrokenWorktreeLink::default();
    let git_path = cwd.join(".git");

    let Ok(meta) = std::fs::symlink_metadata(&git_path) else {
        return not_broken;
    };

    // A main worktree has a `.git` directory; only a `.git` *file* can dangle.
    if meta.is_dir() {
        return not_broken;
    }

    let Ok(content) = std::fs::read_to_string(&git_path) else {
        return not_broken;
    };

    // Parse `gitdir: <path>` (TS regex `^gitdir:\s*(.+)$` on the trimmed text).
    let Some(git_dir) = parse_gitdir(content.trim()) else {
        return not_broken;
    };

    // If the referenced gitdir still exists, the link is fine.
    if Path::new(&git_dir).exists() {
        return not_broken;
    }

    // gitdir is `<main>/.git/worktrees/<name>`; three parents up is `<main>`.
    let main_worktree_path = Path::new(&git_dir)
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(|p| p.to_string_lossy().to_string());

    BrokenWorktreeLink {
        is_broken: true,
        git_dir: Some(git_dir),
        main_worktree_path,
    }
}

/// Extract the path from a `gitdir: <path>` line.
fn parse_gitdir(trimmed: &str) -> Option<String> {
    let rest = trimmed.strip_prefix("gitdir:")?;
    let path = rest.trim_start();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scripted runner: returns a fixed response for the worktree-list call.
    struct MockGit {
        worktree_list: String,
    }
    impl GitRunner for MockGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            if args.contains(&"worktree") && args.contains(&"list") {
                Ok(self.worktree_list.clone())
            } else {
                Ok(String::new())
            }
        }
    }

    #[test]
    fn sanitize_replaces_slashes() {
        assert_eq!(sanitize_branch_name("feat/new-feature"), "feat-new-feature");
        assert_eq!(
            sanitize_branch_name("feat/user/auth/login"),
            "feat-user-auth-login"
        );
        assert_eq!(sanitize_branch_name("simple-branch"), "simple-branch");
        assert_eq!(sanitize_branch_name(""), "");
    }

    #[test]
    fn normalize_https_with_git_suffix() {
        assert_eq!(
            normalize_remote_url("https://github.com/user/repo.git"),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_ssh_scp_format() {
        assert_eq!(
            normalize_remote_url("git@github.com:user/repo.git"),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_ssh_with_protocol() {
        assert_eq!(
            normalize_remote_url("ssh://git@github.com/user/repo.git"),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_http_without_git_suffix() {
        assert_eq!(
            normalize_remote_url("http://github.com/user/repo"),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_url_with_token_credentials() {
        assert_eq!(
            normalize_remote_url("https://token@github.com/user/repo.git"),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_url_with_user_pass_credentials() {
        assert_eq!(
            normalize_remote_url("https://user:pass@github.com/user/repo.git"),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_already_normalized() {
        assert_eq!(
            normalize_remote_url("github.com/user/repo"),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_complex_ssh_with_port() {
        assert_eq!(
            normalize_remote_url("ssh://git@github.com:22/user/repo.git"),
            "github.com:22/user/repo"
        );
    }

    #[test]
    fn normalize_url_with_spaces() {
        assert_eq!(
            normalize_remote_url("  https://github.com/user/repo.git  "),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_gitlab_ssh_nested_groups() {
        assert_eq!(
            normalize_remote_url("git@gitlab.com:group/subgroup/repo.git"),
            "gitlab.com/group/subgroup/repo"
        );
    }

    #[test]
    fn lexical_normalize_folds_dot_and_parent() {
        assert_eq!(lexical_normalize_path("/a/b/../c"), "/a/c");
        assert_eq!(lexical_normalize_path("/a/./b"), "/a/b");
        assert_eq!(lexical_normalize_path("/a//b"), "/a/b");
        assert_eq!(lexical_normalize_path("/a/b/"), "/a/b");
        assert_eq!(lexical_normalize_path("/wt/feat"), "/wt/feat");
        // Relative path with a non-foldable leading `..` keeps it.
        assert_eq!(lexical_normalize_path("../x"), "../x");
    }

    #[test]
    fn get_worktree_by_path_matches_after_normalization() {
        let git = MockGit {
            worktree_list:
                "worktree /test/repo\nbranch refs/heads/main\n\nworktree /test/wt/feat\nbranch refs/heads/feature\n\n"
                    .to_string(),
        };
        // A non-normalized query (with `.` and `..`) still matches the worktree.
        let wt = get_worktree_by_path(&git, "/test/repo/../wt/./feat")
            .unwrap()
            .unwrap();
        assert_eq!(wt.branch, "feature");
        assert_eq!(wt.path, "/test/wt/feat");
    }

    #[test]
    fn get_worktree_by_path_returns_none_when_no_match() {
        let git = MockGit {
            worktree_list: "worktree /test/repo\nbranch refs/heads/main\n\n".to_string(),
        };
        assert_eq!(get_worktree_by_path(&git, "/nowhere").unwrap(), None);
    }

    #[test]
    fn find_worktree_returns_none_when_absent() {
        let git = MockGit {
            worktree_list: "worktree /test/repo\nHEAD abc123\nbranch refs/heads/main\n\n"
                .to_string(),
        };
        assert_eq!(find_worktree_by_branch(&git, "non-existent").unwrap(), None);
    }

    #[test]
    fn find_worktree_returns_path_when_present() {
        let git = MockGit {
            worktree_list: "worktree /test/repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /test/worktrees/feature\nHEAD def456\nbranch refs/heads/feature-branch\n\n"
                .to_string(),
        };
        assert_eq!(
            find_worktree_by_branch(&git, "feature-branch").unwrap(),
            Some("/test/worktrees/feature".to_string())
        );
    }

    // --- Porcelain parser characterization ----------------------------------
    //
    // These lock the CURRENT parse behavior of `parse_worktree_list` against
    // irregular `git worktree list --porcelain` input, so Phase 4 (which adds
    // start/clean over real git) cannot silently change how worktrees are read.

    #[test]
    fn parse_skips_detached_head_entry_without_branch_line() {
        // A detached-HEAD worktree emits `detached` instead of a `branch` line.
        // The parser pushes only on a `branch refs/heads/` line, so the detached
        // entry is intentionally OMITTED from the result.
        let out = "\
worktree /repo/main
HEAD aaaa
branch refs/heads/main

worktree /repo/detached
HEAD bbbb
detached

";
        assert_eq!(
            parse_worktree_list(out),
            vec![Worktree {
                path: "/repo/main".into(),
                branch: "main".into(),
            }],
            "detached entry (no branch line) must be skipped"
        );
    }

    #[test]
    fn parse_handles_worktree_path_with_spaces() {
        // The path is everything after `worktree `, so embedded spaces survive.
        let out = "\
worktree /repo/my worktree dir
HEAD cccc
branch refs/heads/feat

";
        assert_eq!(
            parse_worktree_list(out),
            vec![Worktree {
                path: "/repo/my worktree dir".into(),
                branch: "feat".into(),
            }]
        );
    }

    #[test]
    fn parse_skips_bare_repository_entry() {
        // A bare main repo emits a `bare` line and no branch; it is skipped, but a
        // following normal worktree still parses (and inherits no stale path).
        let out = "\
worktree /repo/bare.git
bare

worktree /repo/wt
HEAD dddd
branch refs/heads/main

";
        assert_eq!(
            parse_worktree_list(out),
            vec![Worktree {
                path: "/repo/wt".into(),
                branch: "main".into(),
            }]
        );
    }

    #[test]
    fn parse_empty_and_whitespace_only_input_yields_no_worktrees() {
        assert!(parse_worktree_list("").is_empty());
        assert!(parse_worktree_list("\n\n").is_empty());
    }

    #[test]
    fn parse_worktree_list_preserves_order() {
        let out = "worktree /a\nbranch refs/heads/main\n\nworktree /b\nbranch refs/heads/feat\n";
        assert_eq!(
            parse_worktree_list(out),
            vec![
                Worktree {
                    path: "/a".into(),
                    branch: "main".into()
                },
                Worktree {
                    path: "/b".into(),
                    branch: "feat".into()
                },
            ]
        );
    }

    #[test]
    fn detect_broken_link_false_for_git_directory() {
        // A real temp dir with a `.git` *directory* is a main worktree.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        let result = detect_broken_worktree_link(tmp.path());
        assert!(!result.is_broken);
    }

    #[test]
    fn detect_broken_link_false_when_gitdir_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main-repo");
        let gitdir = main.join(".git/worktrees/feature");
        std::fs::create_dir_all(&gitdir).unwrap();
        let wt = tmp.path().join("worktrees/feature");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();

        let result = detect_broken_worktree_link(&wt);
        assert!(!result.is_broken);
    }

    #[test]
    fn detect_broken_link_true_when_gitdir_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main-repo");
        // Note: gitdir path is NOT created on disk.
        let gitdir = main.join(".git/worktrees/feature");
        let wt = tmp.path().join("worktrees/feature");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();

        let result = detect_broken_worktree_link(&wt);
        assert!(result.is_broken);
        assert_eq!(result.git_dir.as_deref(), Some(gitdir.to_str().unwrap()));
        assert_eq!(
            result.main_worktree_path.as_deref(),
            Some(main.to_str().unwrap())
        );
    }
}
