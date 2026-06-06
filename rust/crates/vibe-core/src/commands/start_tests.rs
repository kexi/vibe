//! Tests for `start_command`, driven entirely by fakes (no real git/cp/sh).

use super::*;
use crate::copy::strategies::FakeCopyExecutor;
use crate::copy::types::CopyStrategyKind;
use crate::error::VibeError;
use crate::git::RepoInfo;
use crate::hooks::FakeHookRunner;
use crate::io::FakeIo;
use crate::progress::RecordingTracker;
use crate::stdin::FakeStdin;
use crate::worktree_path::ScriptOutput;
use std::cell::RefCell;
use vibe_test_support::Fixture;

const V: &str = "1.8.1+test";

/// A git mock that records calls, serves a worktree list / repo-root / branch
/// existence, and can fail a configured arg prefix.
struct MockGit {
    worktree_list: String,
    repo_root: String,
    local_branches: Vec<String>,
    remote_branches: Vec<String>,
    existing_revisions: Vec<String>,
    pub calls: RefCell<Vec<Vec<String>>>,
}

impl MockGit {
    fn new(repo_root: &str, worktree_list: &str) -> Self {
        MockGit {
            worktree_list: worktree_list.to_string(),
            repo_root: repo_root.to_string(),
            local_branches: vec![],
            remote_branches: vec![],
            existing_revisions: vec![],
            calls: RefCell::new(vec![]),
        }
    }
    fn with_revision(mut self, r: &str) -> Self {
        self.existing_revisions.push(r.to_string());
        self
    }
    fn calls_contain(&self, prefix: &[&str]) -> bool {
        self.calls
            .borrow()
            .iter()
            .any(|c| c.len() >= prefix.len() && c[..prefix.len()] == *prefix)
    }
}

impl GitRunner for MockGit {
    fn run(&self, args: &[&str]) -> Result<String> {
        self.calls
            .borrow_mut()
            .push(args.iter().map(|s| s.to_string()).collect());

        if args.contains(&"--show-toplevel") {
            return Ok(self.repo_root.clone());
        }
        if args.contains(&"list") && args.contains(&"worktree") {
            return Ok(self.worktree_list.clone());
        }
        if args.first() == Some(&"rev-parse") && args.contains(&"--verify") {
            // revision_exists.
            let r = args.last().copied().unwrap_or("");
            return if self.existing_revisions.iter().any(|x| x == r) {
                Ok(String::new())
            } else {
                Err(VibeError::GitOperation {
                    command: args.join(" "),
                    message: "failed: bad rev".into(),
                })
            };
        }
        if args.contains(&"show-ref") {
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
        // worktree add / remove succeed.
        Ok(String::new())
    }
}

/// Resolver returning no repo info (config load → none).
#[derive(Default)]
struct NoResolver;
impl RepoResolver for NoResolver {
    fn repo_info(&self, _path: &str) -> Option<RepoInfo> {
        None
    }
    fn hash_file(&self, _path: &str) -> std::result::Result<String, String> {
        Err("unused".into())
    }
}

/// ScriptRunner that should never run (no path_script configured).
struct NoScript;
impl ScriptRunner for NoScript {
    fn run_script(&self, _cmd: &str, _env: &[(&str, &str)]) -> Result<ScriptOutput> {
        panic!("path script should not run");
    }
}

/// A scripted prompt: confirm answer + a select choice.
struct ScriptPrompt {
    confirm: bool,
    select: usize,
}
impl ScriptPrompt {
    fn confirming(yes: bool) -> Self {
        ScriptPrompt {
            confirm: yes,
            select: 0,
        }
    }
    fn selecting(choice: usize) -> Self {
        ScriptPrompt {
            confirm: false,
            select: choice,
        }
    }
}
impl Prompt for ScriptPrompt {
    fn confirm(&self, _message: &str) -> bool {
        self.confirm
    }
    fn select(&self, _message: &str, _choices: &[String]) -> Result<usize> {
        Ok(self.select)
    }
}

struct Fakes {
    hooks: FakeHookRunner,
    exec: FakeCopyExecutor,
    tracker: RecordingTracker,
}
impl Fakes {
    fn new() -> Self {
        Fakes {
            hooks: FakeHookRunner::ok(),
            exec: FakeCopyExecutor::new(CopyStrategyKind::Standard),
            tracker: RecordingTracker::new(),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn deps<'a>(
    io: &'a FakeIo,
    git: &'a MockGit,
    resolver: &'a NoResolver,
    script: &'a NoScript,
    prompt: &'a ScriptPrompt,
    stdin: &'a FakeStdin,
    fakes: &'a Fakes,
) -> StartDeps<'a, FakeIo, MockGit, NoResolver, NoScript, ScriptPrompt, FakeStdin> {
    StartDeps {
        io,
        git,
        resolver,
        script_runner: script,
        prompt,
        stdin,
        hook_runner: &fakes.hooks,
        executor: &fakes.exec,
        tracker: &fakes.tracker,
        version: V,
    }
}

/// A fake HOME so load_user_settings sees no file and returns defaults.
fn io_with_home() -> (Fixture, FakeIo) {
    let fx = Fixture::new();
    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    (fx, io)
}

fn two_worktrees(main: &str, feat_path: &str, feat_branch: &str) -> String {
    format!("worktree {main}\nbranch refs/heads/main\n\nworktree {feat_path}\nbranch refs/heads/{feat_branch}\n\n")
}

// --- empty name ---

#[test]
fn empty_branch_name_errors() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new("/repo", "worktree /repo\nbranch refs/heads/main\n\n");
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let err = start_command(&d, "", &StartFlags::default(), OutputOptions::default()).unwrap_err();
    assert!(matches!(err, VibeError::AlreadyReported));
    assert!(io.stderr_text().contains("Branch name is required"));
}

// --- existing branch worktree: navigate / decline ---

#[test]
fn existing_branch_worktree_navigates_on_confirm() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new("/repo", &two_worktrees("/repo", "/wt/feat", "feat"));
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let outcome =
        start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::cd("/wt/feat"));
    // No worktree created.
    assert!(!git.calls_contain(&["worktree", "add"]));
}

#[test]
fn existing_branch_worktree_cancels_on_decline() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new("/repo", &two_worktrees("/repo", "/wt/feat", "feat"));
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::confirming(false),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let outcome =
        start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    assert!(io.stderr_text().contains("Cancelled"));
}

#[test]
fn existing_branch_dry_run_does_not_navigate() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new("/repo", &two_worktrees("/repo", "/wt/feat", "feat"));
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let flags = StartFlags {
        dry_run: true,
        ..Default::default()
    };
    let outcome = start_command(&d, "feat", &flags, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    assert!(io.stderr_text().contains("Would navigate to: /wt/feat"));
}

// --- new branch creation (happy path) → cd ---

#[test]
fn new_branch_creates_worktree_and_cds() {
    let (_fx, io) = io_with_home();
    // Only main worktree; no branch "feat" anywhere → brand new.
    let git = MockGit::new(
        "/home/u/repo",
        "worktree /home/u/repo\nbranch refs/heads/main\n\n",
    );
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let outcome =
        start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();
    // default path = dirname(/home/u/repo)/repo-feat = /home/u/repo-feat.
    assert_eq!(outcome, Outcome::cd("/home/u/repo-feat"));
    // The worktree-add argv contains `--` before the path (security #3).
    assert!(git.calls_contain(&["worktree", "add", "-b", "feat", "--", "/home/u/repo-feat"]));
}

#[test]
fn new_branch_dry_run_emits_no_cd_and_logs() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new(
        "/home/u/repo",
        "worktree /home/u/repo\nbranch refs/heads/main\n\n",
    );
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let flags = StartFlags {
        dry_run: true,
        ..Default::default()
    };
    let outcome = start_command(&d, "feat", &flags, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    assert!(io
        .stderr_text()
        .contains("[dry-run] Would run: git worktree add -b feat -- '/home/u/repo-feat'"));
    assert!(io
        .stderr_text()
        .contains("Would change directory to: /home/u/repo-feat"));
    // No real creation in dry-run.
    assert!(!git.calls_contain(&["worktree", "add", "-b", "feat", "--", "/home/u/repo-feat"]));
}

// --- base ref guards ---

#[test]
fn base_not_found_errors() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new("/repo", "worktree /repo\nbranch refs/heads/main\n\n");
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let flags = StartFlags {
        base: Some("nonexistent".into()),
        ..Default::default()
    };
    let err = start_command(&d, "feat", &flags, OutputOptions::default()).unwrap_err();
    assert!(matches!(err, VibeError::AlreadyReported));
    assert!(io.stderr_text().contains("Base 'nonexistent' not found"));
}

#[test]
fn base_with_leading_dash_without_equals_errors() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new("/repo", "worktree /repo\nbranch refs/heads/main\n\n");
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let flags = StartFlags {
        base: Some("-x".into()),
        base_from_equals: false,
        ..Default::default()
    };
    let err = start_command(&d, "feat", &flags, OutputOptions::default()).unwrap_err();
    assert!(matches!(err, VibeError::AlreadyReported));
    assert!(io.stderr_text().contains("--base requires a value"));
}

#[test]
fn base_with_empty_value_errors() {
    // Covers the BaseRef::Invalid arm distinctly from BaseRef::Absent: a
    // whitespace-only --base value reports the error and returns AlreadyReported.
    let (_fx, io) = io_with_home();
    let git = MockGit::new("/repo", "worktree /repo\nbranch refs/heads/main\n\n");
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let flags = StartFlags {
        base: Some("   ".into()),
        ..Default::default()
    };
    let err = start_command(&d, "feat", &flags, OutputOptions::default()).unwrap_err();
    assert!(matches!(err, VibeError::AlreadyReported));
    assert!(io.stderr_text().contains("--base requires a value"));
}

#[test]
fn base_creates_with_base_when_revision_exists() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new(
        "/home/u/repo",
        "worktree /home/u/repo\nbranch refs/heads/main\n\n",
    )
    .with_revision("main");
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let flags = StartFlags {
        base: Some("main".into()),
        track: true,
        ..Default::default()
    };
    let outcome = start_command(&d, "feat", &flags, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::cd("/home/u/repo-feat"));
    assert!(git.calls_contain(&[
        "worktree",
        "add",
        "-b",
        "feat",
        "--track",
        "--",
        "/home/u/repo-feat",
        "main"
    ]));
}

// --- same-branch idempotent re-entry ---

#[test]
fn same_branch_at_target_is_idempotent_cd() {
    let (_fx, io) = io_with_home();
    // The default path /home/u/repo-feat is ALREADY a worktree on branch feat.
    let git = MockGit::new(
        "/home/u/repo",
        // Note: branch "feat" must NOT appear as used by another path, else the
        // earlier existing-branch guard fires. So this worktree's branch is feat
        // and path is the resolved default path → same-branch conflict.
        "worktree /home/u/repo\nbranch refs/heads/main\n\nworktree /home/u/repo-feat\nbranch refs/heads/feat\n\n",
    );
    // But validate_branch_for_worktree would find feat used by /home/u/repo-feat
    // → existing-branch path, navigating. To exercise SAME-BRANCH conflict we
    // need find_worktree_by_branch to NOT match but get_worktree_by_path to
    // match. That requires the worktree's branch == feat at the target path,
    // which find_worktree_by_branch WILL match. So same-branch idempotency in
    // practice is reached via the existing-branch navigate path. We assert that.
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let outcome =
        start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::cd("/home/u/repo-feat"));
}

// --- different-branch conflict: Overwrite / Reuse / Cancel ---

fn conflicting_git() -> MockGit {
    // The resolved default path /home/u/repo-feat holds a DIFFERENT branch
    // "other" (so different-branch conflict), and branch feat is brand new (not
    // used by any worktree → passes validate_branch_for_worktree).
    MockGit::new(
        "/home/u/repo",
        "worktree /home/u/repo\nbranch refs/heads/main\n\nworktree /home/u/repo-feat\nbranch refs/heads/other\n\n",
    )
}

#[test]
fn different_branch_overwrite_removes_and_creates() {
    let (_fx, io) = io_with_home();
    let git = conflicting_git();
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::selecting(0),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let outcome =
        start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::cd("/home/u/repo-feat"));
    // Removed the old worktree (force, with `--`) then created the new one.
    assert!(git.calls_contain(&["worktree", "remove", "--force", "--", "/home/u/repo-feat"]));
    assert!(git.calls_contain(&["worktree", "add", "-b", "feat", "--", "/home/u/repo-feat"]));
}

#[test]
fn different_branch_reuse_runs_hooks_and_cds_without_creating() {
    let (_fx, io) = io_with_home();
    let git = conflicting_git();
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::selecting(1),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let outcome =
        start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::cd("/home/u/repo-feat"));
    // Reuse: no remove, no add.
    assert!(!git.calls_contain(&["worktree", "remove"]));
    assert!(!git.calls_contain(&["worktree", "add"]));
}

/// G-9: the different-branch conflict menu shows exactly Overwrite / Reuse /
/// Cancel, in that order. A recording prompt captures the choices passed to
/// `select` so the menu text + order are asserted (the user-facing contract).
#[test]
fn different_branch_conflict_menu_text_and_order() {
    struct RecordingPrompt {
        choices: RefCell<Vec<String>>,
    }
    impl Prompt for RecordingPrompt {
        fn confirm(&self, _m: &str) -> bool {
            false
        }
        fn select(&self, _m: &str, choices: &[String]) -> Result<usize> {
            *self.choices.borrow_mut() = choices.to_vec();
            Ok(2) // Cancel — we only care about the menu, not the action.
        }
    }

    let (_fx, io) = io_with_home();
    let git = conflicting_git();
    let p = RecordingPrompt {
        choices: RefCell::new(vec![]),
    };
    let (r, s, sin, fk) = (NoResolver, NoScript, FakeStdin::none(), Fakes::new());
    let d = StartDeps {
        io: &io,
        git: &git,
        resolver: &r,
        script_runner: &s,
        prompt: &p,
        stdin: &sin,
        hook_runner: &fk.hooks,
        executor: &fk.exec,
        tracker: &fk.tracker,
        version: V,
    };
    start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();
    assert_eq!(
        *p.choices.borrow(),
        vec![
            "Overwrite (remove and recreate)".to_string(),
            "Reuse (use existing)".to_string(),
            "Cancel".to_string(),
        ],
        "conflict menu text/order must be Overwrite, Reuse, Cancel"
    );
}

#[test]
fn different_branch_cancel_emits_no_cd() {
    let (_fx, io) = io_with_home();
    let git = conflicting_git();
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::selecting(2),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let outcome =
        start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    assert!(io.stderr_text().contains("Cancelled"));
    assert!(!git.calls_contain(&["worktree", "add"]));
}

// --- config-driven hooks + copy order/cwd (with trusted config) ---

/// Build a trusted-config fixture + resolver, returning (fixture, io, resolver,
/// repo_root). The config has a pre_start, a copy file, and a post_start hook.
fn trusted_config_repo() -> (Fixture, FakeIo, TrustResolver, String) {
    use crate::hash::hash_content;
    use crate::settings::{AllowEntry, RepoId, VibeSettings};
    use crate::settings_io::save_user_settings;
    use std::collections::HashMap;

    let fx = Fixture::new();
    let repo = fx.mkdir("repo");
    let content = "[hooks]\npre_start = [\"echo pre\"]\npost_start = [\"echo post\"]\n[copy]\nfiles = [\".env\"]\n";
    fx.write("repo/.vibe.toml", content);
    fx.write("repo/.env", "SECRET=1");

    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());

    let mut settings = VibeSettings::default_settings();
    settings.permissions.allow.push(AllowEntry {
        repo_id: RepoId {
            remote_url: None,
            repo_root: Some(repo.to_string_lossy().into_owned()),
        },
        relative_path: ".vibe.toml".into(),
        hashes: vec![hash_content(content.as_bytes())],
        skip_hash_check: None,
    });
    save_user_settings(&io, &settings, V).unwrap();

    let mut repos = HashMap::new();
    repos.insert(
        repo.join(".vibe.toml").to_string_lossy().into_owned(),
        RepoInfo {
            remote_url: None,
            repo_root: repo.to_string_lossy().into_owned(),
            relative_path: ".vibe.toml".into(),
        },
    );
    (
        fx,
        io,
        TrustResolver { repos },
        repo.to_string_lossy().into_owned(),
    )
}

struct TrustResolver {
    repos: std::collections::HashMap<String, RepoInfo>,
}
impl RepoResolver for TrustResolver {
    fn repo_info(&self, path: &str) -> Option<RepoInfo> {
        self.repos.get(path).cloned()
    }
    fn hash_file(&self, path: &str) -> std::result::Result<String, String> {
        crate::hash::hash_file(path).map_err(|e| e.to_string())
    }
}

#[test]
fn runs_pre_then_copy_then_post_with_correct_cwds() {
    let (fx, io, resolver, repo_root) = trusted_config_repo();
    let _ = &fx;
    // Brand-new branch, default path under repo root's parent.
    let git = MockGit::new(
        &repo_root,
        &format!("worktree {repo_root}\nbranch refs/heads/main\n\n"),
    );
    let s = NoScript;
    let p = ScriptPrompt::confirming(true);
    let sin = FakeStdin::none();
    let fk = Fakes::new();
    let d = StartDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        script_runner: &s,
        prompt: &p,
        stdin: &sin,
        hook_runner: &fk.hooks,
        executor: &fk.exec,
        tracker: &fk.tracker,
        version: V,
    };
    let outcome =
        start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();
    assert!(outcome.cd_path.is_some());

    // Hooks ran in order: pre (cwd=repo_root) then post (cwd=worktree_path).
    let calls = fk.hooks.calls.borrow();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].0, "echo pre");
    assert_eq!(calls[0].1, repo_root); // pre runs in repo_root.
    assert_eq!(calls[1].0, "echo post");
    let wt_path = outcome.cd_path.clone().unwrap();
    assert_eq!(calls[1].1, wt_path); // post runs in the worktree.

    // The copy file was attempted.
    assert_eq!(fk.exec.file_copies.lock().unwrap().len(), 1);
}

#[test]
fn no_hooks_and_no_copy_skip_operations() {
    let (fx, io, resolver, repo_root) = trusted_config_repo();
    let _ = &fx;
    let git = MockGit::new(
        &repo_root,
        &format!("worktree {repo_root}\nbranch refs/heads/main\n\n"),
    );
    let s = NoScript;
    let p = ScriptPrompt::confirming(true);
    let sin = FakeStdin::none();
    let fk = Fakes::new();
    let d = StartDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        script_runner: &s,
        prompt: &p,
        stdin: &sin,
        hook_runner: &fk.hooks,
        executor: &fk.exec,
        tracker: &fk.tracker,
        version: V,
    };
    let flags = StartFlags {
        no_hooks: true,
        no_copy: true,
        ..Default::default()
    };
    start_command(&d, "feat", &flags, OutputOptions::default()).unwrap();
    assert!(fk.hooks.calls.borrow().is_empty());
    assert!(fk.exec.file_copies.lock().unwrap().is_empty());
}

// --- claude-code worktree hook mode: stdout path ---

#[test]
fn worktree_hook_mode_outputs_path_to_stdout() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new(
        "/home/u/repo",
        "worktree /home/u/repo\nbranch refs/heads/main\n\n",
    );
    let s = NoScript;
    let p = ScriptPrompt::confirming(true);
    let sin = FakeStdin::text(r#"{"name": "from-stdin"}"#);
    let fk = Fakes::new();
    let d = deps(&io, &git, &NoResolver, &s, &p, &sin, &fk);
    let flags = StartFlags {
        worktree_hook: true,
        ..Default::default()
    };
    let outcome = start_command(&d, "", &flags, OutputOptions::default()).unwrap();
    // Outputs the worktree PATH as stdout (NOT a cd).
    assert_eq!(outcome.cd_path, None);
    assert_eq!(outcome.stdout.as_deref(), Some("/home/u/repo-from-stdin"));
    assert!(git.calls_contain(&[
        "worktree",
        "add",
        "-b",
        "from-stdin",
        "--",
        "/home/u/repo-from-stdin"
    ]));
}

#[test]
fn worktree_hook_mode_requires_a_name() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new(
        "/home/u/repo",
        "worktree /home/u/repo\nbranch refs/heads/main\n\n",
    );
    let s = NoScript;
    let p = ScriptPrompt::confirming(true);
    let sin = FakeStdin::none(); // no stdin name, no CLI name.
    let fk = Fakes::new();
    let d = deps(&io, &git, &NoResolver, &s, &p, &sin, &fk);
    let flags = StartFlags {
        worktree_hook: true,
        ..Default::default()
    };
    let err = start_command(&d, "", &flags, OutputOptions::default()).unwrap_err();
    assert!(matches!(err, VibeError::AlreadyReported));
    assert!(io.stderr_text().contains("requires a name via stdin"));
}

// --- G-6: --no-track / --track argv through start_command (TS parity) ---

#[test]
fn base_without_track_emits_no_track_flag() {
    // start --base <ref> with track=false → the worktree-add argv must carry
    // `--no-track` (TS `createWorktree` emits `--no-track` when track is false and
    // a base is given; `--track` when true).
    let (_fx, io) = io_with_home();
    let git = MockGit::new(
        "/home/u/repo",
        "worktree /home/u/repo\nbranch refs/heads/main\n\n",
    )
    .with_revision("origin/main");
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let flags = StartFlags {
        base: Some("origin/main".into()),
        track: false,
        ..Default::default()
    };
    let outcome = start_command(&d, "feat", &flags, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::cd("/home/u/repo-feat"));
    assert!(git.calls_contain(&[
        "worktree",
        "add",
        "-b",
        "feat",
        "--no-track",
        "--",
        "/home/u/repo-feat",
        "origin/main"
    ]));
    // And NOT the --track variant.
    assert!(!git.calls_contain(&[
        "worktree",
        "add",
        "-b",
        "feat",
        "--track",
        "--",
        "/home/u/repo-feat",
        "origin/main"
    ]));
}

#[test]
fn base_with_track_emits_track_flag() {
    // The complementary half of G-6: track=true → `--track`, never `--no-track`.
    let (_fx, io) = io_with_home();
    let git = MockGit::new(
        "/home/u/repo",
        "worktree /home/u/repo\nbranch refs/heads/main\n\n",
    )
    .with_revision("origin/main");
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = deps(&io, &git, &r, &s, &p, &sin, &fk);
    let flags = StartFlags {
        base: Some("origin/main".into()),
        track: true,
        ..Default::default()
    };
    start_command(&d, "feat", &flags, OutputOptions::default()).unwrap();
    assert!(git.calls_contain(&[
        "worktree",
        "add",
        "-b",
        "feat",
        "--track",
        "--",
        "/home/u/repo-feat",
        "origin/main"
    ]));
    assert!(!git.calls_contain(&[
        "worktree",
        "add",
        "-b",
        "feat",
        "--no-track",
        "--",
        "/home/u/repo-feat",
        "origin/main"
    ]));
}

// --- G-7: claude-hook mode, branch already in a worktree → output existing path ---

#[test]
fn worktree_hook_mode_existing_branch_outputs_existing_path_without_creating() {
    let (_fx, io) = io_with_home();
    // Branch "feat" is ALREADY used by another worktree at /wt/feat.
    let git = MockGit::new(
        "/home/u/repo",
        &two_worktrees("/home/u/repo", "/wt/feat", "feat"),
    );
    let s = NoScript;
    let p = ScriptPrompt::confirming(true);
    let sin = FakeStdin::text(r#"{"name": "feat"}"#);
    let fk = Fakes::new();
    let d = deps(&io, &git, &NoResolver, &s, &p, &sin, &fk);
    let flags = StartFlags {
        worktree_hook: true,
        ..Default::default()
    };
    let outcome = start_command(&d, "", &flags, OutputOptions::default()).unwrap();
    // Outputs the EXISTING worktree path (not a cd), and creates nothing.
    assert_eq!(outcome.cd_path, None);
    assert_eq!(outcome.stdout.as_deref(), Some("/wt/feat"));
    assert!(!git.calls_contain(&["worktree", "add"]));
}

// --- G-8: claude-hook mode, post-setup failure is NON-FATAL ---

#[test]
fn worktree_hook_mode_post_setup_failure_is_non_fatal() {
    // A post_start hook FAILS, but hook mode must still return Outcome::stdout(path)
    // (it warns rather than erroring — important for Claude Code integration).
    let (fx, io, resolver, repo_root) = trusted_config_repo();
    let _ = &fx;
    let git = MockGit::new(
        &repo_root,
        &format!("worktree {repo_root}\nbranch refs/heads/main\n\n"),
    );
    let s = NoScript;
    let p = ScriptPrompt::confirming(true);
    let sin = FakeStdin::text(r#"{"name": "hooked"}"#);
    // The post_start hook ("echo post") fails with a nonzero exit.
    let hooks = FakeHookRunner::failing_on("post", 1, "boom");
    let exec = FakeCopyExecutor::new(CopyStrategyKind::Standard);
    let tracker = RecordingTracker::new();
    let d = StartDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        script_runner: &s,
        prompt: &p,
        stdin: &sin,
        hook_runner: &hooks,
        executor: &exec,
        tracker: &tracker,
        version: V,
    };
    let flags = StartFlags {
        worktree_hook: true,
        ..Default::default()
    };
    let outcome = start_command(&d, "", &flags, OutputOptions::default()).unwrap();
    // Despite the failing hook, the path is still emitted (non-fatal warn).
    assert_eq!(outcome.cd_path, None);
    let wt = outcome.stdout.clone().expect("must output a path");
    assert!(wt.ends_with("-hooked"), "unexpected path: {wt}");
    assert!(
        io.stderr_text().contains("Post-setup failed"),
        "should warn about the failed post-setup: {}",
        io.stderr_text()
    );
    // The worktree WAS created (the failure is post-creation).
    assert!(git.calls_contain(&["worktree", "add"]));
}

#[test]
fn worktree_hook_mode_cli_name_wins_over_stdin() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new(
        "/home/u/repo",
        "worktree /home/u/repo\nbranch refs/heads/main\n\n",
    );
    let s = NoScript;
    let p = ScriptPrompt::confirming(true);
    let sin = FakeStdin::text(r#"{"name": "stdin-name"}"#);
    let fk = Fakes::new();
    let d = deps(&io, &git, &NoResolver, &s, &p, &sin, &fk);
    let flags = StartFlags {
        worktree_hook: true,
        ..Default::default()
    };
    let outcome = start_command(&d, "cli-name", &flags, OutputOptions::default()).unwrap();
    assert_eq!(outcome.stdout.as_deref(), Some("/home/u/repo-cli-name"));
}
