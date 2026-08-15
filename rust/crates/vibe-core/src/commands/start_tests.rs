//! Tests for `start_command`, driven entirely by fakes (no real git/cp/sh).

use super::*;
use crate::copy::strategies::FakeCopyExecutor;
use crate::copy::symlink::FakeSymlinkCreator;
use crate::copy::types::CopyStrategyKind;
use crate::error::VibeError;
use crate::git::RepoInfo;
use crate::hooks::FakeHookRunner;
use crate::io::FakeIo;
use crate::progress::{RecordingTracker, TrackerEvent};
use crate::stdin::FakeStdin;
use crate::worktree_path::ScriptOutput;
use std::cell::RefCell;
use std::sync::LazyLock;
use vibe_test_support::{fake_root_str, to_slash, Fixture};

const V: &str = "1.8.1+test";

/// The repo root and the worktree paths `start` derives from it.
///
/// Built per-host rather than written as `/home/u/...` literals: `start` resolves
/// the worktree path with `dirname` + `join`, which use the host separator, and a
/// `/`-joined literal is not even absolute on Windows. See #570.
static REPO: LazyLock<String> = LazyLock::new(|| fake_root_str("home/u/repo"));
static REPO_FEAT: LazyLock<String> = LazyLock::new(|| fake_root_str("home/u/repo-feat"));
static REPO_FROM_STDIN: LazyLock<String> =
    LazyLock::new(|| fake_root_str("home/u/repo-from-stdin"));
static REPO_CLI_NAME: LazyLock<String> = LazyLock::new(|| fake_root_str("home/u/repo-cli-name"));

/// `git worktree list --porcelain` output listing only the main worktree.
///
/// Built from [`REPO`] rather than written inline: `start` matches the paths in
/// this listing against the target path it computes with `Path::join`, so a
/// `/`-joined literal here would never match on Windows — the conflict would go
/// undetected and the command would silently take the plain-create branch.
fn main_only() -> String {
    format!("worktree {}\nbranch refs/heads/main\n\n", *REPO)
}

/// The listing above plus a second worktree at the resolved default path
/// ([`REPO_FEAT`]) on `branch`, i.e. the path-conflict fixture.
fn main_and_feat_path_on(branch: &str) -> String {
    format!(
        "worktree {}\nbranch refs/heads/main\n\nworktree {}\nbranch refs/heads/{branch}\n\n",
        *REPO, *REPO_FEAT
    )
}

/// A git mock that records calls, serves a worktree list / repo-root / branch
/// existence, and can fail a configured arg prefix.
struct MockGit {
    worktree_list: String,
    repo_root: String,
    local_branches: Vec<String>,
    remote_branches: Vec<String>,
    existing_revisions: Vec<String>,
    fail_prefix: Option<Vec<String>>,
    /// NUL-delimited `ls-files --others` payload (untracked candidates).
    untracked: String,
    /// NUL-delimited `ls-files --modified` payload.
    modified: String,
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
            fail_prefix: None,
            untracked: String::new(),
            modified: String::new(),
            calls: RefCell::new(vec![]),
        }
    }
    fn with_revision(mut self, r: &str) -> Self {
        self.existing_revisions.push(r.to_string());
        self
    }
    /// Canned `git ls-files -z` payloads (NUL-delimited, terminator included).
    fn with_ls_files(mut self, untracked: &[&str], modified: &[&str]) -> Self {
        let encode = |items: &[&str]| {
            items
                .iter()
                .map(|s| format!("{s}\0"))
                .collect::<Vec<_>>()
                .join("")
        };
        self.untracked = encode(untracked);
        self.modified = encode(modified);
        self
    }
    fn failing_on(mut self, prefix: &[&str]) -> Self {
        self.fail_prefix = Some(prefix.iter().map(|s| s.to_string()).collect());
        self
    }
    fn calls_contain(&self, prefix: &[&str]) -> bool {
        self.calls
            .borrow()
            .iter()
            .any(|c| c.len() >= prefix.len() && c[..prefix.len()] == *prefix)
    }
    fn submodule_update_calls(&self) -> usize {
        self.calls
            .borrow()
            .iter()
            .filter(|c| {
                c.iter().any(|arg| arg == "submodule")
                    && c.iter().any(|arg| arg == "update")
                    && c.iter().any(|arg| arg == "--init")
            })
            .count()
    }
}

impl GitRunner for MockGit {
    fn run(&self, args: &[&str]) -> Result<String> {
        self.calls
            .borrow_mut()
            .push(args.iter().map(|s| s.to_string()).collect());

        if let Some(prefix) = &self.fail_prefix {
            let is_matching_prefix = args.len() >= prefix.len()
                && args
                    .iter()
                    .take(prefix.len())
                    .zip(prefix.iter())
                    .all(|(actual, expected)| actual == expected);
            if is_matching_prefix {
                return Err(VibeError::GitOperation {
                    command: args.join(" "),
                    message: "failed: submodule update".into(),
                });
            }
        }

        if args.contains(&"--show-toplevel") {
            return Ok(self.repo_root.clone());
        }
        if args.first() == Some(&"ls-files") {
            return Ok(if args.contains(&"--others") {
                self.untracked.clone()
            } else {
                self.modified.clone()
            });
        }
        if args.contains(&"config") && args.contains(&"--file") && args.contains(&".gitmodules") {
            let gitmodules = std::path::Path::new(&self.repo_root).join(".gitmodules");
            let content =
                std::fs::read_to_string(&gitmodules).map_err(|e| VibeError::GitOperation {
                    command: args.join(" "),
                    message: format!("failed: {e}"),
                })?;
            let paths = parse_gitmodules_paths_for_test(&content);
            if paths.is_empty() {
                return Err(VibeError::GitOperation {
                    command: args.join(" "),
                    message: "failed: no submodule paths".into(),
                });
            }
            return Ok(paths
                .into_iter()
                .map(|path| format!("submodule.test.path {path}"))
                .collect::<Vec<_>>()
                .join("\n"));
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

    // `-z` output must not be trimmed and is raw bytes; the mock serves the same
    // payload either way, but overriding here keeps the double honest about the
    // real contract.
    fn run_raw(&self, args: &[&str]) -> Result<Vec<u8>> {
        self.run(args).map(String::into_bytes)
    }
}

fn parse_gitmodules_paths_for_test(content: &str) -> Vec<String> {
    content
        .lines()
        .filter_map(|line| line.trim().strip_prefix("path"))
        .filter_map(|line| line.trim_start().strip_prefix('='))
        .map(|path| path.trim().trim_matches('"').to_string())
        .collect()
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

struct PanicPrompt;
impl Prompt for PanicPrompt {
    fn confirm(&self, message: &str) -> bool {
        panic!("confirm prompt should not run: {message}");
    }
    fn select(&self, message: &str, _choices: &[String]) -> Result<usize> {
        panic!("select prompt should not run: {message}");
    }
}

struct Fakes {
    hooks: FakeHookRunner,
    exec: FakeCopyExecutor,
    symlinks: FakeSymlinkCreator,
    tracker: RecordingTracker,
}
impl Fakes {
    fn new() -> Self {
        Fakes {
            hooks: FakeHookRunner::ok(),
            exec: FakeCopyExecutor::new(CopyStrategyKind::Standard),
            symlinks: FakeSymlinkCreator::new(),
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
        symlink_creator: &fakes.symlinks,
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
fn new_worktree_creation_is_tracked_even_without_config_operations() {
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
    let outcome =
        start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();

    assert!(outcome.cd_path.is_some());
    assert!(git.calls_contain(&["worktree", "add"]));

    let events = fk.tracker.events();
    let create_task = events.iter().any(|event| match event {
        TrackerEvent::Task(label) => label == "Create worktree",
        _ => false,
    });
    assert!(create_task, "create task should be tracked: {events:?}");
    assert!(events.contains(&TrackerEvent::Started));
    assert!(events.contains(&TrackerEvent::Finished));
    assert!(events.contains(&TrackerEvent::Phase("Setting up worktree feat".into())));
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
fn existing_branch_force_navigates_without_prompt() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new("/repo", &two_worktrees("/repo", "/wt/feat", "feat"));
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        PanicPrompt,
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = StartDeps {
        io: &io,
        git: &git,
        resolver: &r,
        script_runner: &s,
        prompt: &p,
        stdin: &sin,
        hook_runner: &fk.hooks,
        executor: &fk.exec,
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    let flags = StartFlags {
        force: true,
        ..Default::default()
    };
    let outcome = start_command(&d, "feat", &flags, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::cd("/wt/feat"));
    assert!(!git.calls_contain(&["worktree", "add"]));
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
    let git = MockGit::new(&REPO, &main_only());
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
    assert_eq!(outcome, Outcome::cd(&**REPO_FEAT));
    // The worktree-add argv contains `--` before the path (security #3).
    assert!(git.calls_contain(&["worktree", "add", "-b", "feat", "--", &REPO_FEAT]));
}

#[test]
fn new_branch_dry_run_emits_no_cd_and_logs() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new(&REPO, &main_only());
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
    assert!(io.stderr_text().contains(&format!(
        "[dry-run] Would run: git worktree add -b feat -- '{}'",
        *REPO_FEAT
    )));
    assert!(io
        .stderr_text()
        .contains(&format!("Would change directory to: {}", *REPO_FEAT)));
    // No real creation in dry-run.
    assert!(!git.calls_contain(&["worktree", "add", "-b", "feat", "--", &REPO_FEAT]));
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
    let git = MockGit::new(&REPO, &main_only()).with_revision("main");
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
    assert_eq!(outcome, Outcome::cd(&**REPO_FEAT));
    assert!(
        git.calls_contain(&["worktree", "add", "-b", "feat", "--track", "--", &REPO_FEAT, "main"])
    );
}

// --- same-branch idempotent re-entry ---

#[test]
fn same_branch_at_target_is_idempotent_cd() {
    let (_fx, io) = io_with_home();
    // The default path /home/u/repo-feat is ALREADY a worktree on branch feat.
    let git = MockGit::new(
        &REPO,
        // Note: branch "feat" must NOT appear as used by another path, else the
        // earlier existing-branch guard fires. So this worktree's branch is feat
        // and path is the resolved default path → same-branch conflict.
        &main_and_feat_path_on("feat"),
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
    assert_eq!(outcome, Outcome::cd(&**REPO_FEAT));
}

// --- different-branch conflict: Overwrite / Reuse / Cancel ---

fn conflicting_git() -> MockGit {
    // The resolved default path /home/u/repo-feat holds a DIFFERENT branch
    // "other" (so different-branch conflict), and branch feat is brand new (not
    // used by any worktree → passes validate_branch_for_worktree).
    MockGit::new(&REPO, &main_and_feat_path_on("other"))
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
    assert_eq!(outcome, Outcome::cd(&**REPO_FEAT));
    // Removed the old worktree (force, with `--`) then created the new one.
    assert!(git.calls_contain(&["worktree", "remove", "--force", "--", &REPO_FEAT]));
    assert!(git.calls_contain(&["worktree", "add", "-b", "feat", "--", &REPO_FEAT]));
}

#[test]
fn different_branch_force_overwrites_without_prompt() {
    let (_fx, io) = io_with_home();
    let git = conflicting_git();
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        PanicPrompt,
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = StartDeps {
        io: &io,
        git: &git,
        resolver: &r,
        script_runner: &s,
        prompt: &p,
        stdin: &sin,
        hook_runner: &fk.hooks,
        executor: &fk.exec,
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    let flags = StartFlags {
        force: true,
        ..Default::default()
    };
    let outcome = start_command(&d, "feat", &flags, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::cd(&**REPO_FEAT));
    assert!(git.calls_contain(&["worktree", "remove", "--force", "--", &REPO_FEAT]));
    assert!(git.calls_contain(&["worktree", "add", "-b", "feat", "--", &REPO_FEAT]));
}

#[test]
fn different_branch_reuse_flag_reuses_without_prompt() {
    let (_fx, io) = io_with_home();
    let git = conflicting_git();
    // PanicPrompt asserts the flag path NEVER prompts (the --force counterpart).
    let (r, s, p, sin, fk) = (
        NoResolver,
        NoScript,
        PanicPrompt,
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = StartDeps {
        io: &io,
        git: &git,
        resolver: &r,
        script_runner: &s,
        prompt: &p,
        stdin: &sin,
        hook_runner: &fk.hooks,
        executor: &fk.exec,
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    let flags = StartFlags {
        reuse: true,
        ..Default::default()
    };
    let outcome = start_command(&d, "feat", &flags, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::cd(&**REPO_FEAT));
    // Reuse: no remove, no add — the existing worktree is kept as-is.
    assert!(!git.calls_contain(&["worktree", "remove"]));
    assert!(!git.calls_contain(&["worktree", "add"]));
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
    assert_eq!(outcome, Outcome::cd(&**REPO_FEAT));
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
        symlink_creator: &fk.symlinks,
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
    trusted_config_repo_with_content(
        "[hooks]\npre_start = [\"echo pre\"]\npost_start = [\"echo post\"]\n[copy]\nfiles = [\".env\"]\n",
    )
}

fn trusted_config_repo_with_content(content: &str) -> (Fixture, FakeIo, TrustResolver, String) {
    use crate::hash::hash_content;
    use crate::settings::{AllowEntry, RepoId, VibeSettings};
    use crate::settings_io::save_user_settings;
    use std::collections::HashMap;

    let fx = Fixture::new();
    let repo = fx.mkdir("repo");
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
        config_semantics_rev: None,
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

fn trusted_repo_with_submodule_config() -> (Fixture, FakeIo, TrustResolver, String) {
    use crate::hash::hash_content;
    use crate::settings::{AllowEntry, RepoId, VibeSettings};
    use crate::settings_io::save_user_settings;
    use std::collections::HashMap;

    let fx = Fixture::new();
    let repo_raw = fx.mkdir("repo");
    let submodule_origin_raw = fx.mkdir("repo/libs/foo");
    let worktree_raw = fx.mkdir("repo-feat");
    let _ = fx.mkdir("repo-feat/libs/foo");

    let parent = "[submodules]\nconfigs = [\"libs/foo\"]\n[hooks]\npre_start = [\"echo parent\"]\n";
    let origin_submodule = "[hooks]\npre_start = [\"echo origin-sub-pre\"]\n";
    let worktree_submodule = "[hooks]\npre_start = [\"echo sub-pre\"]\npost_start = [\"echo sub-post\"]\n[copy]\nfiles = [\".env\"]\n";
    fx.write("repo/.vibe.toml", parent);
    fx.write(
        "repo/.gitmodules",
        "[submodule \"libs/foo\"]\n\tpath = libs/foo\n\turl = https://example.com/foo.git\n",
    );
    fx.write("repo/libs/foo/.vibe.toml", origin_submodule);
    fx.write("repo-feat/libs/foo/.vibe.toml", worktree_submodule);
    fx.write("repo-feat/libs/foo/.env", "SUB=1");

    let repo = repo_raw.canonicalize().unwrap();
    let submodule_origin = submodule_origin_raw.canonicalize().unwrap();
    let worktree = worktree_raw.canonicalize().unwrap();
    let submodule_worktree = worktree.join("libs/foo").canonicalize().unwrap();

    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let mut settings = VibeSettings::default_settings();
    for (root, file, content) in [
        (&repo, ".vibe.toml", parent),
        (&submodule_origin, ".vibe.toml", origin_submodule),
        (&submodule_worktree, ".vibe.toml", worktree_submodule),
    ] {
        settings.permissions.allow.push(AllowEntry {
            repo_id: RepoId {
                remote_url: None,
                repo_root: Some(root.to_string_lossy().into_owned()),
            },
            relative_path: file.into(),
            hashes: vec![hash_content(content.as_bytes())],
            skip_hash_check: None,
            config_semantics_rev: None,
        });
    }
    save_user_settings(&io, &settings, V).unwrap();

    let mut repos = HashMap::new();
    for (root, file) in [
        (&repo, ".vibe.toml"),
        (&submodule_origin, ".vibe.toml"),
        (&submodule_worktree, ".vibe.toml"),
    ] {
        repos.insert(
            root.join(file).to_string_lossy().into_owned(),
            RepoInfo {
                remote_url: None,
                repo_root: root.to_string_lossy().into_owned(),
                relative_path: file.into(),
            },
        );
    }
    (
        fx,
        io,
        TrustResolver { repos },
        repo.to_string_lossy().into_owned(),
    )
}

fn start_with_config(
    content: &str,
    fail_prefix: Option<&[&str]>,
    flags: &StartFlags,
) -> (
    Fixture,
    FakeIo,
    TrustResolver,
    String,
    MockGit,
    Fakes,
    Result<Outcome>,
) {
    let (fx, io, resolver, repo_root) = trusted_config_repo_with_content(content);
    let mut git = MockGit::new(
        &repo_root,
        &format!("worktree {repo_root}\nbranch refs/heads/main\n\n"),
    );
    if let Some(prefix) = fail_prefix {
        git = git.failing_on(prefix);
    }
    let s = NoScript;
    let p = ScriptPrompt::confirming(true);
    let sin = FakeStdin::none();
    let fk = Fakes::new();
    let result = {
        let d = StartDeps {
            io: &io,
            git: &git,
            resolver: &resolver,
            script_runner: &s,
            prompt: &p,
            stdin: &sin,
            hook_runner: &fk.hooks,
            executor: &fk.exec,
            symlink_creator: &fk.symlinks,
            tracker: &fk.tracker,
            version: V,
        };
        start_command(&d, "feat", flags, OutputOptions::default())
    };
    (fx, io, resolver, repo_root, git, fk, result)
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
        symlink_creator: &fk.symlinks,
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

// --- [copy] untracked / modified (issue #580) ---

/// Drive `start` over a trusted config plus canned `ls-files` payloads, and
/// return the repo-relative source paths that were actually copied.
fn copied_sources_for(
    config: &str,
    untracked: &[&str],
    modified: &[&str],
    extra_files: &[&str],
    flags: &StartFlags,
) -> (Vec<String>, String) {
    let (fx, io, resolver, repo_root) = trusted_config_repo_with_content(config);
    for rel in extra_files {
        fx.write(format!("repo/{rel}"), "x");
    }
    let git = MockGit::new(
        &repo_root,
        &format!("worktree {repo_root}\nbranch refs/heads/main\n\n"),
    )
    .with_ls_files(untracked, modified);
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
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    start_command(&d, "feat", flags, OutputOptions::default()).unwrap();
    let copies = fk.exec.file_copies.lock().unwrap();
    let sources = copies
        .iter()
        .map(|(src, _)| {
            to_slash(src)
                .rsplit_once("/repo/")
                .map(|(_, rel)| rel.to_string())
                .unwrap_or_else(|| to_slash(src))
        })
        .collect();
    (sources, io.stderr_text())
}

/// Config with no copy sources enabled at all — the default.
const NO_COPY_SOURCES: &str = "[copy]\nfiles = []\n";

#[test]
fn untracked_and_modified_are_off_by_default() {
    let (copied, _) = copied_sources_for(
        NO_COPY_SOURCES,
        &["scratch.md"],
        &["src/main.rs"],
        &["scratch.md", "src/main.rs"],
        &StartFlags::default(),
    );
    assert!(
        copied.is_empty(),
        "neither source may be copied without an opt-in: {copied:?}"
    );
}

#[test]
fn config_untracked_true_copies_untracked_files() {
    let (copied, _) = copied_sources_for(
        "[copy]\nuntracked = true\n",
        &["scratch.md", "notes/todo.txt"],
        &["src/main.rs"],
        &["scratch.md", "notes/todo.txt", "src/main.rs"],
        &StartFlags::default(),
    );
    // Untracked only: the modified tracked file is NOT picked up.
    assert_eq!(
        copied,
        vec!["scratch.md".to_string(), "notes/todo.txt".to_string()]
    );
}

#[test]
fn config_modified_true_copies_modified_tracked_files() {
    let (copied, _) = copied_sources_for(
        "[copy]\nmodified = true\n",
        &["scratch.md"],
        &["src/main.rs"],
        &["scratch.md", "src/main.rs"],
        &StartFlags::default(),
    );
    assert_eq!(copied, vec!["src/main.rs".to_string()]);
}

#[test]
fn cli_flags_enable_the_sources_without_config() {
    let flags = StartFlags {
        copy_untracked: true,
        copy_modified: true,
        ..Default::default()
    };
    let (copied, _) = copied_sources_for(
        NO_COPY_SOURCES,
        &["scratch.md"],
        &["src/main.rs"],
        &["scratch.md", "src/main.rs"],
        &flags,
    );
    assert_eq!(
        copied,
        vec!["scratch.md".to_string(), "src/main.rs".to_string()]
    );
}

#[test]
fn no_copy_skips_untracked_and_modified_too() {
    let flags = StartFlags {
        no_copy: true,
        copy_untracked: true,
        copy_modified: true,
        ..Default::default()
    };
    let (copied, _) = copied_sources_for(
        "[copy]\nuntracked = true\nmodified = true\n",
        &["scratch.md"],
        &["src/main.rs"],
        &["scratch.md", "src/main.rs"],
        &flags,
    );
    assert!(
        copied.is_empty(),
        "--no-copy must suppress the git-derived sources as well: {copied:?}"
    );
}

#[test]
fn git_derived_files_do_not_duplicate_configured_patterns() {
    // `.env` is written by the fixture and listed in `[copy] files`; git also
    // reports it as untracked. It must be copied exactly once.
    let (copied, _) = copied_sources_for(
        "[copy]\nfiles = [\".env\"]\nuntracked = true\n",
        &[".env", "scratch.md"],
        &[],
        &["scratch.md"],
        &StartFlags::default(),
    );
    assert_eq!(
        copied,
        vec![".env".to_string(), "scratch.md".to_string()],
        "a path in both sources is copied once"
    );
}

#[test]
fn glob_metacharacters_in_git_reported_names_are_literal() {
    // A literal file named `weird[1].txt` must be copied as-is, not treated as a
    // character-class glob (which would match nothing and silently drop it).
    let (copied, _) = copied_sources_for(
        "[copy]\nuntracked = true\n",
        &["weird[1].txt"],
        &[],
        &["weird[1].txt"],
        &StartFlags::default(),
    );
    assert_eq!(copied, vec!["weird[1].txt".to_string()]);
}

#[test]
fn spaced_and_non_ascii_names_are_copied() {
    let (copied, _) = copied_sources_for(
        "[copy]\nuntracked = true\n",
        &["my note.txt", "メモ.txt"],
        &[],
        &["my note.txt", "メモ.txt"],
        &StartFlags::default(),
    );
    assert_eq!(
        copied,
        vec!["my note.txt".to_string(), "メモ.txt".to_string()]
    );
}

/// A hook runner that materializes files in the origin repo as a side effect,
/// standing in for a real `pre_start` hook that writes scratch files.
struct FileWritingHooks {
    /// `(repo-relative path, contents)` written on the FIRST hook invocation.
    writes: Vec<(String, String)>,
    repo_root: String,
    calls: RefCell<Vec<String>>,
}

impl crate::hooks::HookRunner for FileWritingHooks {
    fn run_hook(
        &self,
        cmd: &str,
        _cwd: &str,
        _env: &[(&str, &str)],
    ) -> Result<crate::hooks::HookOutput> {
        self.calls.borrow_mut().push(cmd.to_string());
        for (rel, contents) in &self.writes {
            let path = std::path::Path::new(&self.repo_root).join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&path, contents).unwrap();
        }
        Ok(crate::hooks::HookOutput {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        })
    }
}

#[test]
fn files_created_by_a_pre_start_hook_are_carried_over() {
    // The documented order is pre_start → copy → post_start, so a file a
    // `pre_start` hook writes into the origin repo must be visible to
    // `--copy-untracked`. Enumerating before the hooks ran would drop
    // `generated.txt` on the existence check, since it does not exist yet.
    let config = "[copy]\nuntracked = true\n\n[hooks]\npre_start = [\"generate\"]\n";
    let (fx, io, resolver, repo_root) = trusted_config_repo_with_content(config);
    fx.write("repo/scratch.md", "already here");

    let git = MockGit::new(
        &repo_root,
        &format!("worktree {repo_root}\nbranch refs/heads/main\n\n"),
    )
    // git reports both once they exist; only `scratch.md` exists before the hook.
    .with_ls_files(&["scratch.md", "generated.txt"], &[]);
    let s = NoScript;
    let p = ScriptPrompt::confirming(true);
    let sin = FakeStdin::none();
    let fk = Fakes::new();
    let hooks = FileWritingHooks {
        writes: vec![("generated.txt".to_string(), "made by the hook".to_string())],
        repo_root: repo_root.clone(),
        calls: RefCell::new(vec![]),
    };
    let d = StartDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        script_runner: &s,
        prompt: &p,
        stdin: &sin,
        hook_runner: &hooks,
        executor: &fk.exec,
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();

    assert_eq!(
        hooks.calls.borrow().len(),
        1,
        "pre_start hook must have run"
    );
    let copies = fk.exec.file_copies.lock().unwrap();
    let sources: Vec<String> = copies
        .iter()
        .map(|(src, _)| {
            to_slash(src)
                .rsplit_once("/repo/")
                .map(|(_, rel)| rel.to_string())
                .unwrap_or_else(|| to_slash(src))
        })
        .collect();
    assert!(
        sources.contains(&"generated.txt".to_string()),
        "a file created by pre_start must be enumerated for the copy: {sources:?}"
    );
    assert!(sources.contains(&"scratch.md".to_string()), "{sources:?}");
}

#[test]
fn cli_flags_work_in_a_repo_with_no_vibe_toml() {
    // The ad-hoc case the flags exist for: carry work in progress into a new
    // worktree in a repo where nobody has written a config. `NoResolver` makes
    // the config load return None, so this exercises the absent-config path.
    let fx = Fixture::new();
    let repo = fx.mkdir("repo");
    fx.write("repo/scratch.md", "wip");
    let repo_root = repo.to_string_lossy().into_owned();
    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());

    let git = MockGit::new(
        &repo_root,
        &format!("worktree {repo_root}\nbranch refs/heads/main\n\n"),
    )
    .with_ls_files(&["scratch.md"], &[]);
    let resolver = NoResolver;
    let s = NoScript;
    let p = ScriptPrompt::confirming(true);
    let sin = FakeStdin::none();
    let fk = Fakes::new();
    let d = deps(&io, &git, &resolver, &s, &p, &sin, &fk);

    let flags = StartFlags {
        copy_untracked: true,
        ..Default::default()
    };
    start_command(&d, "feat", &flags, OutputOptions::default()).unwrap();

    let copies = fk.exec.file_copies.lock().unwrap();
    assert_eq!(copies.len(), 1, "expected the untracked file to be copied");
    assert!(to_slash(&copies[0].0).ends_with("repo/scratch.md"));
}

#[test]
fn no_config_and_no_flags_still_short_circuits_without_touching_git() {
    let fx = Fixture::new();
    let repo = fx.mkdir("repo");
    fx.write("repo/scratch.md", "wip");
    let repo_root = repo.to_string_lossy().into_owned();
    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());

    let git = MockGit::new(
        &repo_root,
        &format!("worktree {repo_root}\nbranch refs/heads/main\n\n"),
    )
    .with_ls_files(&["scratch.md"], &[]);
    let resolver = NoResolver;
    let s = NoScript;
    let p = ScriptPrompt::confirming(true);
    let sin = FakeStdin::none();
    let fk = Fakes::new();
    let d = deps(&io, &git, &resolver, &s, &p, &sin, &fk);

    start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();

    assert!(fk.exec.file_copies.lock().unwrap().is_empty());
    assert!(
        !git.calls_contain(&["ls-files"]),
        "no config and no opt-in must not run ls-files at all"
    );
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
        symlink_creator: &fk.symlinks,
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

// --- [copy] symlink: shared directories instead of copies ---

/// A trusted repo whose config also has a `[copy] symlink` list, with `.cache`
/// and `node_modules` present in the origin and the target worktree directory
/// already on disk (MockGit does not really run `git worktree add`, but the
/// symlink step needs a real destination to canonicalize).
fn trusted_symlink_repo(content: &str) -> (Fixture, FakeIo, TrustResolver, String) {
    let (fx, io, resolver, repo_root) = trusted_config_repo_with_content(content);
    fx.mkdir("repo/.cache");
    fx.mkdir("repo/node_modules");
    // The default worktree path is `<repo parent>/<repo name>-<sanitized branch>`.
    fx.mkdir("repo-feat");
    (fx, io, resolver, repo_root)
}

#[test]
fn symlink_entries_are_linked_instead_of_copied() {
    let (fx, io, resolver, repo_root) =
        trusted_symlink_repo("[copy]\ndirs = [\"node_modules\"]\nsymlink = [\".cache\"]\n");
    let _ = &fx;
    let git = MockGit::new(
        &repo_root,
        &format!("worktree {repo_root}\nbranch refs/heads/main\n\n"),
    );
    let (s, p, sin, fk) = (
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = StartDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        script_runner: &s,
        prompt: &p,
        stdin: &sin,
        hook_runner: &fk.hooks,
        executor: &fk.exec,
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();

    // `.cache` was linked, `node_modules` was still copied.
    let links = fk.symlinks.links.lock().unwrap();
    assert_eq!(links.len(), 1, "expected exactly one symlink: {links:?}");
    assert!(links[0].0.ends_with(".cache"), "target: {}", links[0].0);
    let dir_copies = fk.exec.dir_copies.lock().unwrap();
    assert_eq!(dir_copies.len(), 1);
    assert!(
        dir_copies[0].0.ends_with("node_modules"),
        "src: {}",
        dir_copies[0].0
    );
}

#[test]
fn symlink_entry_takes_precedence_over_the_same_dirs_entry() {
    let (fx, io, resolver, repo_root) = trusted_symlink_repo(
        "[copy]\ndirs = [\"node_modules\", \".cache\"]\nsymlink = [\".cache\"]\n",
    );
    let _ = &fx;
    let git = MockGit::new(
        &repo_root,
        &format!("worktree {repo_root}\nbranch refs/heads/main\n\n"),
    );
    let (s, p, sin, fk) = (
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = StartDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        script_runner: &s,
        prompt: &p,
        stdin: &sin,
        hook_runner: &fk.hooks,
        executor: &fk.exec,
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();

    // `.cache` is listed in BOTH dirs and symlink: it must be linked, not copied.
    assert_eq!(fk.symlinks.links.lock().unwrap().len(), 1);
    let dir_copies = fk.exec.dir_copies.lock().unwrap();
    assert_eq!(
        dir_copies.len(),
        1,
        "the symlinked dir must not also be copied: {dir_copies:?}"
    );
    assert!(dir_copies[0].0.ends_with("node_modules"));
}

#[test]
fn no_copy_skips_symlinks_too() {
    let (fx, io, resolver, repo_root) = trusted_symlink_repo("[copy]\nsymlink = [\".cache\"]\n");
    let _ = &fx;
    let git = MockGit::new(
        &repo_root,
        &format!("worktree {repo_root}\nbranch refs/heads/main\n\n"),
    );
    let (s, p, sin, fk) = (
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = StartDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        script_runner: &s,
        prompt: &p,
        stdin: &sin,
        hook_runner: &fk.hooks,
        executor: &fk.exec,
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    let flags = StartFlags {
        no_copy: true,
        ..Default::default()
    };
    start_command(&d, "feat", &flags, OutputOptions::default()).unwrap();
    assert!(
        fk.symlinks.links.lock().unwrap().is_empty(),
        "--no-copy must skip the symlink step as well"
    );
}

#[test]
fn dry_run_reports_symlinks_without_creating_them() {
    let (fx, io, resolver, repo_root) = trusted_symlink_repo("[copy]\nsymlink = [\".cache\"]\n");
    let _ = &fx;
    let git = MockGit::new(
        &repo_root,
        &format!("worktree {repo_root}\nbranch refs/heads/main\n\n"),
    );
    let (s, p, sin, fk) = (
        NoScript,
        ScriptPrompt::confirming(true),
        FakeStdin::none(),
        Fakes::new(),
    );
    let d = StartDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        script_runner: &s,
        prompt: &p,
        stdin: &sin,
        hook_runner: &fk.hooks,
        executor: &fk.exec,
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    let flags = StartFlags {
        dry_run: true,
        ..Default::default()
    };
    start_command(&d, "feat", &flags, OutputOptions::default()).unwrap();
    assert!(fk.symlinks.links.lock().unwrap().is_empty());
    assert!(
        io.stderr_text().contains("Would symlink directories:"),
        "stderr: {}",
        io.stderr_text()
    );
}

#[test]
fn a_failing_symlink_does_not_abort_start() {
    let (fx, io, resolver, repo_root) =
        trusted_symlink_repo("[copy]\ndirs = [\"node_modules\"]\nsymlink = [\".cache\"]\n");
    let _ = &fx;
    let git = MockGit::new(
        &repo_root,
        &format!("worktree {repo_root}\nbranch refs/heads/main\n\n"),
    );
    let (s, p, sin) = (NoScript, ScriptPrompt::confirming(true), FakeStdin::none());
    // Emulates Windows without Developer Mode.
    let fk = Fakes {
        symlinks: FakeSymlinkCreator::failing("A required privilege is not held"),
        ..Fakes::new()
    };
    let d = StartDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        script_runner: &s,
        prompt: &p,
        stdin: &sin,
        hook_runner: &fk.hooks,
        executor: &fk.exec,
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    let outcome =
        start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();

    // The worktree is still usable: start succeeded, the copies still ran, and
    // the failure was only a warning.
    assert!(outcome.cd_path.is_some());
    assert_eq!(fk.exec.dir_copies.lock().unwrap().len(), 1);
    assert!(
        io.stderr_text().contains("Failed to symlink .cache"),
        "stderr: {}",
        io.stderr_text()
    );
}

#[test]
fn submodule_configs_run_before_parent_pre_start_with_submodule_roots() {
    let (fx, io, resolver, repo_root) = trusted_repo_with_submodule_config();
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
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap();

    assert!(git.calls_contain(&[
        "-C",
        &format!("{}-feat", repo_root),
        "submodule",
        "update",
        "--init",
        "--",
        "libs/foo"
    ]));

    // The paths are real (fixture-derived) and so carry the host separator; the
    // suffix under test is the submodule's position in the tree, not its
    // punctuation, so compare on the `/`-rendered form.
    let hooks = fk.hooks.calls.borrow();
    assert_eq!(hooks[0].0, "echo sub-pre");
    assert!(to_slash(&hooks[0].1).ends_with("repo-feat/libs/foo"));
    assert_eq!(hooks[1].0, "echo sub-post");
    assert!(to_slash(&hooks[1].1).ends_with("repo-feat/libs/foo"));
    assert_eq!(hooks[2].0, "echo parent");
    assert_eq!(hooks[2].1, repo_root);

    let file_copies = fk.exec.file_copies.lock().unwrap();
    assert_eq!(file_copies.len(), 1);
    assert!(to_slash(&file_copies[0].0).ends_with("repo/libs/foo/.env"));
    assert!(to_slash(&file_copies[0].1).ends_with("repo-feat/libs/foo/.env"));
}

#[test]
fn submodule_configs_are_skipped_when_omitted() {
    let content = "[hooks]\npre_start = [\"echo pre\"]\n";
    let (_fx, _io, _resolver, _repo_root, git, _fk, result) =
        start_with_config(content, None, &StartFlags::default());
    result.unwrap();
    assert_eq!(git.submodule_update_calls(), 0);
}

#[test]
fn submodule_configs_respect_no_hooks_and_no_copy() {
    let (fx, io, resolver, repo_root) = trusted_repo_with_submodule_config();
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
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    let flags = StartFlags {
        no_hooks: true,
        no_copy: true,
        ..Default::default()
    };
    start_command(&d, "feat", &flags, OutputOptions::default()).unwrap();

    assert_eq!(git.submodule_update_calls(), 1);
    assert!(fk.hooks.calls.borrow().is_empty());
    assert!(fk.exec.file_copies.lock().unwrap().is_empty());
}

#[test]
fn submodule_configs_dry_run_logs_without_running_git() {
    let (fx, io, resolver, repo_root) = trusted_repo_with_submodule_config();
    let _ = &fx;
    std::fs::remove_dir_all(format!("{repo_root}-feat")).unwrap();
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
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    let flags = StartFlags {
        dry_run: true,
        ..Default::default()
    };
    start_command(&d, "feat", &flags, OutputOptions::default()).unwrap();

    assert_eq!(git.submodule_update_calls(), 0);
    assert!(io.stderr_text().contains("Would run: git -C"));
    assert!(io
        .stderr_text()
        .contains("submodule update --init -- libs/foo"));
}

#[test]
fn submodule_config_update_failure_aborts_remaining_operations() {
    let (fx, io, resolver, repo_root) = trusted_repo_with_submodule_config();
    let _ = &fx;
    let git = MockGit::new(
        &repo_root,
        &format!("worktree {repo_root}\nbranch refs/heads/main\n\n"),
    )
    .failing_on(&["-C", &format!("{}-feat", repo_root), "submodule"]);
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
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    let result = start_command(&d, "feat", &StartFlags::default(), OutputOptions::default());

    assert!(result.is_err());
    assert!(fk.hooks.calls.borrow().is_empty());
    assert!(fk.exec.file_copies.lock().unwrap().is_empty());
}

#[test]
fn submodule_config_invalid_path_is_rejected_before_git_update() {
    let content = "[submodules]\nconfigs = [\"../foo\"]\n";
    let (_fx, _io, _resolver, _repo_root, git, _fk, result) =
        start_with_config(content, None, &StartFlags::default());

    let err = result.unwrap_err();
    assert!(err
        .to_string()
        .contains("must be a parent-repo-relative submodule path"));
    assert_eq!(git.submodule_update_calls(), 0);
}

#[test]
fn submodule_config_requires_its_own_trust() {
    let (fx, io, mut resolver, repo_root) = trusted_repo_with_submodule_config();
    let _ = &fx;
    // Drop the submodule config's trust entry. The map is keyed by real
    // (host-separator) paths, so the suffix is matched on the `/`-rendered form —
    // otherwise nothing is removed on Windows and the case under test (an
    // UNtrusted submodule config) never actually happens.
    resolver
        .repos
        .retain(|path, _| !to_slash(path).ends_with("repo-feat/libs/foo/.vibe.toml"));
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
        symlink_creator: &fk.symlinks,
        tracker: &fk.tracker,
        version: V,
    };
    let err =
        start_command(&d, "feat", &StartFlags::default(), OutputOptions::default()).unwrap_err();

    assert!(err
        .to_string()
        .contains(".vibe.toml file is not trusted or has been modified"));
    assert!(fk.hooks.calls.borrow().is_empty());
}

// --- claude-code worktree hook mode: stdout path ---

#[test]
fn worktree_hook_mode_outputs_path_to_stdout() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new(&REPO, &main_only());
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
    assert_eq!(outcome.stdout.as_deref(), Some(REPO_FROM_STDIN.as_str()));
    assert!(git.calls_contain(&[
        "worktree",
        "add",
        "-b",
        "from-stdin",
        "--",
        &REPO_FROM_STDIN
    ]));
}

#[test]
fn worktree_hook_mode_requires_a_name() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new(&REPO, &main_only());
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
    let git = MockGit::new(&REPO, &main_only()).with_revision("origin/main");
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
    assert_eq!(outcome, Outcome::cd(&**REPO_FEAT));
    assert!(git.calls_contain(&[
        "worktree",
        "add",
        "-b",
        "feat",
        "--no-track",
        "--",
        &REPO_FEAT,
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
        &REPO_FEAT,
        "origin/main"
    ]));
}

#[test]
fn base_with_track_emits_track_flag() {
    // The complementary half of G-6: track=true → `--track`, never `--no-track`.
    let (_fx, io) = io_with_home();
    let git = MockGit::new(&REPO, &main_only()).with_revision("origin/main");
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
        &REPO_FEAT,
        "origin/main"
    ]));
    assert!(!git.calls_contain(&[
        "worktree",
        "add",
        "-b",
        "feat",
        "--no-track",
        "--",
        &REPO_FEAT,
        "origin/main"
    ]));
}

// --- G-7: claude-hook mode, branch already in a worktree → output existing path ---

#[test]
fn worktree_hook_mode_existing_branch_outputs_existing_path_without_creating() {
    let (_fx, io) = io_with_home();
    // Branch "feat" is ALREADY used by another worktree at /wt/feat.
    let git = MockGit::new(&REPO, &two_worktrees(&REPO, "/wt/feat", "feat"));
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
    let symlink_creator = FakeSymlinkCreator::new();
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
        symlink_creator: &symlink_creator,
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
    let git = MockGit::new(&REPO, &main_only());
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
    assert_eq!(outcome.stdout.as_deref(), Some(REPO_CLI_NAME.as_str()));
}
