//! Tests for `clean_command`, driven by fakes (no real git/sh/fs removal).

use super::*;
use crate::clock::{FakeClock, FakeRandom};
use crate::copy::native::FakeNative;
use crate::error::VibeError;
use crate::fast_remove::FakeBackgroundSpawner;
use crate::git::RepoInfo;
use crate::hooks::FakeHookRunner;
use crate::io::FakeIo;
use crate::progress::NullTracker;
use crate::settings::VibeSettings;
use crate::settings_io::save_user_settings;
use crate::stdin::FakeStdin;
use crate::timestamp::LocalTime;
use std::cell::RefCell;
use vibe_test_support::{fake_root_str, Fixture};

const V: &str = "1.8.1+test";

struct MockGit {
    repo_root: String,
    main_path: String,
    worktree_list: String,
    uncommitted: bool,
    /// What `symbolic-ref refs/remotes/origin/HEAD --short` answers; `None` →
    /// the ref is missing. Kept so a test can declare a branch "the default"
    /// and prove `clean` deletes it anyway.
    origin_head: Option<String>,
    pub calls: RefCell<Vec<Vec<String>>>,
}
impl MockGit {
    fn new(repo_root: &str, main_path: &str, worktree_list: &str) -> Self {
        MockGit {
            repo_root: repo_root.to_string(),
            main_path: main_path.to_string(),
            worktree_list: worktree_list.to_string(),
            uncommitted: false,
            origin_head: None,
            calls: RefCell::new(vec![]),
        }
    }
    fn with_uncommitted(mut self, yes: bool) -> Self {
        self.uncommitted = yes;
        self
    }
    /// Make `origin/HEAD` resolve to `branch`, i.e. declare it the default.
    fn with_default_branch(mut self, branch: &str) -> Self {
        self.origin_head = Some(format!("origin/{branch}"));
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
        // is_main_worktree compares show-toplevel to the first worktree-list entry.
        if args.contains(&"--show-toplevel") {
            return Ok(self.repo_root.clone());
        }
        if args.contains(&"list") && args.contains(&"worktree") {
            return Ok(self.worktree_list.clone());
        }
        if args.contains(&"status") {
            return Ok(if self.uncommitted { " M file" } else { "" }.to_string());
        }
        // The zero-exit probe `resolve_default_branch` uses to confirm whether
        // refs/remotes/origin/HEAD exists: empty output = confirmed absent.
        if args.first() == Some(&"for-each-ref") && args.contains(&"refs/remotes/origin/HEAD") {
            return Ok(match &self.origin_head {
                Some(_) => "refs/remotes/origin/HEAD".to_string(),
                None => String::new(),
            });
        }
        if args.contains(&"symbolic-ref") {
            return match &self.origin_head {
                Some(h) => Ok(h.clone()),
                None => Err(VibeError::GitOperation {
                    command: args.join(" "),
                    message: "failed: is not a symbolic ref".into(),
                }),
            };
        }
        if args.contains(&"init.defaultBranch") {
            // Unconfigured: no fixture branch here is named `master`.
            return Err(VibeError::GitOperation {
                command: args.join(" "),
                message: "failed: key missing".into(),
            });
        }
        // worktree remove / branch -d succeed.
        Ok(String::new())
    }
}
// main_path is used implicitly via the worktree list's first entry.
#[allow(dead_code)]
fn _touch(g: &MockGit) {
    let _ = &g.main_path;
}

#[derive(Default)]
struct NoResolver;
impl RepoResolver for NoResolver {
    fn repo_info(&self, _p: &str) -> Option<RepoInfo> {
        None
    }
    fn hash_file(&self, _p: &str) -> std::result::Result<String, String> {
        Err("unused".into())
    }
}
struct ScriptPrompt {
    confirm: bool,
}
impl Prompt for ScriptPrompt {
    fn confirm(&self, _m: &str) -> bool {
        self.confirm
    }
    fn select(&self, _m: &str, _c: &[String]) -> Result<usize> {
        Ok(0)
    }
}

/// Records chdir targets; can fail a target.
struct FakeProcess {
    cwd: RefCell<String>,
    chdirs: RefCell<Vec<String>>,
    fail_to: Option<String>,
}
impl FakeProcess {
    fn new(cwd: &str) -> Self {
        FakeProcess {
            cwd: RefCell::new(cwd.to_string()),
            chdirs: RefCell::new(vec![]),
            fail_to: None,
        }
    }
    fn failing_to(cwd: &str, target: &str) -> Self {
        FakeProcess {
            cwd: RefCell::new(cwd.to_string()),
            chdirs: RefCell::new(vec![]),
            fail_to: Some(target.to_string()),
        }
    }
}
impl ProcessControl for FakeProcess {
    fn chdir(&self, path: &str) -> Result<()> {
        self.chdirs.borrow_mut().push(path.to_string());
        if self.fail_to.as_deref() == Some(path) {
            return Err(VibeError::FileSystem(format!("cannot chdir {path}")));
        }
        *self.cwd.borrow_mut() = path.to_string();
        Ok(())
    }
    fn current_dir(&self) -> Result<String> {
        Ok(self.cwd.borrow().clone())
    }
}

struct Fakes {
    hooks: FakeHookRunner,
    native: FakeNative,
    spawner: FakeBackgroundSpawner,
    tracker: NullTracker,
    clock: FakeClock,
    random: FakeRandom,
}
impl Fakes {
    fn new() -> Self {
        Fakes {
            hooks: FakeHookRunner::ok(),
            // Native trash available so fast-remove takes the trash path (no fs).
            native: FakeNative::linux(),
            spawner: FakeBackgroundSpawner::new(),
            tracker: NullTracker,
            clock: FakeClock::new(
                1000,
                LocalTime {
                    year: 2026,
                    month: 6,
                    day: 6,
                    hour: 0,
                    minute: 0,
                    second: 0,
                },
            ),
            random: FakeRandom::fixed("abcd1234"),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn deps<'a>(
    io: &'a FakeIo,
    git: &'a MockGit,
    resolver: &'a NoResolver,
    prompt: &'a ScriptPrompt,
    process: &'a FakeProcess,
    stdin: &'a FakeStdin,
    fakes: &'a Fakes,
    cwd: &'a str,
) -> CleanDeps<'a, FakeIo, MockGit, NoResolver, ScriptPrompt, FakeProcess, FakeStdin> {
    CleanDeps {
        io,
        git,
        resolver,
        prompt,
        process,
        stdin,
        hook_runner: &fakes.hooks,
        native: &fakes.native,
        spawner: &fakes.spawner,
        tracker: &fakes.tracker,
        clock: &fakes.clock,
        random: &fakes.random,
        cwd,
        version: V,
    }
}

fn io_with_home() -> (Fixture, FakeIo) {
    let fx = Fixture::new();
    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    (fx, io)
}

/// porcelain: main first, then the secondary worktree (current).
fn two_worktrees(main: &str, feat_path: &str, feat_branch: &str) -> String {
    format!("worktree {main}\nbranch refs/heads/main\n\nworktree {feat_path}\nbranch refs/heads/{feat_branch}\n\n")
}

// --- not-main guard ---

#[test]
fn cannot_clean_main_worktree() {
    let (_fx, io) = io_with_home();
    // repo_root (show-toplevel) == main worktree path → is_main true.
    let git = MockGit::new(
        "/main",
        "/main",
        &two_worktrees("/main", "/wt/feat", "feat"),
    );
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: true },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new("/main");
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, "/main");
    let err = clean_command(&d, &CleanFlags::default(), OutputOptions::default()).unwrap_err();
    assert!(matches!(err, VibeError::AlreadyReported));
    assert!(io.stderr_text().contains("Cannot clean main worktree"));
}

// --- broken-link guard ---

#[test]
fn broken_worktree_link_errors() {
    let (_fx, io) = io_with_home();
    // Build a real broken-link cwd: a .git FILE pointing at a missing gitdir.
    let tmp = Fixture::new();
    let wt = tmp.mkdir("worktrees/feature");
    let missing_gitdir = tmp.path().join("main/.git/worktrees/feature");
    std::fs::write(
        wt.join(".git"),
        format!("gitdir: {}\n", missing_gitdir.display()),
    )
    .unwrap();
    let cwd = wt.to_string_lossy().into_owned();

    let git = MockGit::new(&cwd, "/main", &two_worktrees("/main", &cwd, "feat"));
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: true },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new(&cwd);
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, &cwd);
    let err = clean_command(&d, &CleanFlags::default(), OutputOptions::default()).unwrap_err();
    assert!(matches!(err, VibeError::Worktree(_)));
    assert!(err
        .to_string()
        .contains("main worktree appears to have been deleted"));
}

// --- uncommitted changes confirm / cancel ---

#[test]
fn uncommitted_changes_cancel_aborts() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new(
        "/wt/feat",
        "/main",
        &two_worktrees("/main", "/wt/feat", "feat"),
    )
    .with_uncommitted(true);
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: false },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new("/wt/feat");
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, "/wt/feat");
    let outcome = clean_command(&d, &CleanFlags::default(), OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    assert!(io.stderr_text().contains("Clean operation cancelled."));
    // Nothing removed.
    assert!(!git.calls_contain(&["-C", "/main", "worktree", "remove"]));
}

#[test]
fn uncommitted_changes_force_skips_confirm() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new(
        "/wt/feat",
        "/main",
        &two_worktrees("/main", "/wt/feat", "feat"),
    )
    .with_uncommitted(true);
    // confirm=false would cancel, but --force skips the prompt.
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: false },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new("/wt/feat");
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, "/wt/feat");
    let flags = CleanFlags {
        force: true,
        ..Default::default()
    };
    let outcome = clean_command(&d, &flags, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::cd("/main"));
}

// --- fast-remove path: native trash, then git remove --force -- ---

#[test]
fn fast_remove_uses_native_trash_then_git_remove_force() {
    // The worktree must be a real dir with a `.git` file for fast-remove. The
    // gitdir must EXIST on disk, else the broken-link guard fires before clean.
    let fx = Fixture::new();
    let wt = fx.mkdir("wt-feat");
    let gitdir = fx.mkdir("main/.git/worktrees/feat");
    std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
    let wt_path = wt.to_string_lossy().into_owned();

    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let git = MockGit::new(&wt_path, "/main", &two_worktrees("/main", &wt_path, "feat"));
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: true },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new(&wt_path);
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, &wt_path);
    let outcome = clean_command(&d, &CleanFlags::default(), OutputOptions::default()).unwrap();

    assert_eq!(outcome, Outcome::cd("/main"));
    // chdir to main happened before removal.
    assert_eq!(proc.chdirs.borrow().as_slice(), &["/main".to_string()]);
    // Native trash was used.
    assert_eq!(fk.native.trash_calls.borrow().len(), 1);
    // Then a forced git worktree remove with `--` on the empty dir.
    assert!(git.calls_contain(&["-C", "/main", "worktree", "remove", "--force", "--", &wt_path]));
}

// --- G-11: fast-remove sub-steps are observable, in order ---

#[test]
fn fast_remove_recreates_empty_dir_and_git_file_before_git_remove() {
    // This locks the workaround that lets `git worktree remove` succeed after the
    // dir was trashed: read `.git` content → trash → recreate empty dir + `.git`
    // file → `git -C main worktree remove --force -- <path>`. If the recreate step
    // regresses, worktrees get left half-removed.
    let fx = Fixture::new();
    let wt = fx.mkdir("wt-feat");
    let gitdir = fx.mkdir("main/.git/worktrees/feat");
    let git_file_content = format!("gitdir: {}\n", gitdir.display());
    std::fs::write(wt.join(".git"), &git_file_content).unwrap();
    let wt_path = wt.to_string_lossy().into_owned();

    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let git = MockGit::new(&wt_path, "/main", &two_worktrees("/main", &wt_path, "feat"));
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: true },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new(&wt_path);
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, &wt_path);
    clean_command(&d, &CleanFlags::default(), OutputOptions::default()).unwrap();

    // Sub-step 2: native trash was used (mv-to-trash).
    assert_eq!(fk.native.trash_calls.borrow().len(), 1);
    assert_eq!(
        fk.native.trash_calls.borrow()[0],
        wt_path,
        "trash must target the worktree path"
    );
    // Sub-step 3: the empty dir + `.git` file were recreated with the ORIGINAL
    // content read before the move (the workaround that lets git remove succeed).
    let recreated_git = wt.join(".git");
    assert!(
        recreated_git.exists(),
        ".git file must be recreated after trashing"
    );
    assert_eq!(
        std::fs::read_to_string(&recreated_git).unwrap(),
        git_file_content,
        ".git must be recreated with the original gitdir content"
    );
    // Sub-step 4: the forced git remove with `--` ran on the recreated dir.
    assert!(git.calls_contain(&["-C", "/main", "worktree", "remove", "--force", "--", &wt_path]));
    // The trash call happened BEFORE the git remove (recorded order proxy: trash
    // is recorded during fast_remove, git remove is a later git call).
    let git_remove_seen = git.calls.borrow().iter().any(|c| {
        c.len() >= 5 && c[0] == "-C" && c[2] == "worktree" && c[3] == "remove" && c[4] == "--force"
    });
    assert!(git_remove_seen, "git worktree remove --force must have run");
}

// --- traditional remove when fast_remove disabled in settings ---

#[test]
fn fast_remove_disabled_uses_traditional_remove() {
    let fx = Fixture::new();
    let wt = fx.mkdir("wt-feat");
    let wt_path = wt.to_string_lossy().into_owned();
    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());

    // Persist settings with clean.fast_remove=false in `extra`.
    let mut settings = VibeSettings::default_settings();
    settings.extra.insert(
        "clean".to_string(),
        serde_json::json!({ "fast_remove": false }),
    );
    save_user_settings(&io, &settings, V).unwrap();

    let git = MockGit::new(&wt_path, "/main", &two_worktrees("/main", &wt_path, "feat"));
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: true },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new(&wt_path);
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, &wt_path);
    clean_command(&d, &CleanFlags::default(), OutputOptions::default()).unwrap();

    // Traditional path: NO native trash, plain `worktree remove -- <path>`.
    assert!(fk.native.trash_calls.borrow().is_empty());
    assert!(git.calls_contain(&["-C", "/main", "worktree", "remove", "--", &wt_path]));
}

// --- fast-remove falls back (and says why) when `.git` cannot be read ---

#[test]
fn unreadable_git_file_falls_back_to_traditional_remove_with_verbose_reason() {
    // Fast remove must read the worktree's `.git` link file so it can recreate
    // it after the move; when that read fails it silently degrades to the
    // traditional path. This guarantees the degradation still removes the
    // worktree AND that --verbose names the unreadable path, so a slow clean is
    // diagnosable. `.git` as a directory is the portable unreadable case.
    let fx = Fixture::new();
    let wt = fx.mkdir("wt-feat");
    fx.mkdir("wt-feat/.git");
    let wt_path = wt.to_string_lossy().into_owned();

    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let git = MockGit::new(&wt_path, "/main", &two_worktrees("/main", &wt_path, "feat"));
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: true },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new(&wt_path);
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, &wt_path);
    clean_command(&d, &CleanFlags::default(), OutputOptions::new(true, false)).unwrap();

    // Fast remove was entered but abandoned: nothing was trashed.
    assert!(fk.native.trash_calls.borrow().is_empty());
    // The worktree is still removed, via the traditional path.
    assert!(git.calls_contain(&["-C", "/main", "worktree", "remove", "--", &wt_path]));
    // And the reason is reported under --verbose, naming the offending path.
    let stderr = io.stderr_text();
    assert!(
        stderr.contains("Fast remove unavailable: cannot read"),
        "verbose output must explain the fallback, got: {stderr}"
    );
    assert!(
        stderr.contains(&wt.join(".git").display().to_string()),
        "verbose output must name the unreadable .git path, got: {stderr}"
    );
}

// --- delete-branch precedence ---

#[test]
fn delete_branch_flag_deletes_branch() {
    let fx = Fixture::new();
    let wt = fx.mkdir("wt-feat");
    let wt_path = wt.to_string_lossy().into_owned();
    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let git = MockGit::new(&wt_path, "/main", &two_worktrees("/main", &wt_path, "feat"));
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: true },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new(&wt_path);
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, &wt_path);
    let flags = CleanFlags {
        delete_branch: true,
        ..Default::default()
    };
    clean_command(&d, &flags, OutputOptions::default()).unwrap();
    // branch -d with `--` on the branch.
    assert!(git.calls_contain(&["-C", "/main", "branch", "-d", "--", "feat"]));
}

#[test]
fn keep_branch_flag_wins_over_config_delete() {
    let fx = Fixture::new();
    let wt = fx.mkdir("wt-feat");
    let wt_path = wt.to_string_lossy().into_owned();
    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let git = MockGit::new(&wt_path, "/main", &two_worktrees("/main", &wt_path, "feat"));
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: true },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new(&wt_path);
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, &wt_path);
    let flags = CleanFlags {
        keep_branch: true,
        ..Default::default()
    };
    clean_command(&d, &flags, OutputOptions::default()).unwrap();
    assert!(!git.calls_contain(&["-C", "/main", "branch", "-d"]));
}

#[test]
fn default_does_not_delete_branch() {
    let fx = Fixture::new();
    let wt = fx.mkdir("wt-feat");
    let wt_path = wt.to_string_lossy().into_owned();
    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let git = MockGit::new(&wt_path, "/main", &two_worktrees("/main", &wt_path, "feat"));
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: true },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new(&wt_path);
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, &wt_path);
    clean_command(&d, &CleanFlags::default(), OutputOptions::default()).unwrap();
    assert!(!git.calls_contain(&["-C", "/main", "branch", "-d"]));
}

// --- no default-branch guard (#578 reverted) ---

/// What it guarantees: `--delete-branch` deletes the branch even when it is the
/// one `origin/HEAD` calls the repository's default.
///
/// The guard removed here (issue #578) soft-skipped that deletion. It inferred
/// the default from `refs/remotes/origin/HEAD`, which `git clone` writes once
/// and never refreshes: across 109 measured repositories it disagreed with the
/// remote's real default in 7, every one of them a repository whose default had
/// moved to `develop` while `origin/HEAD` still said `main`. It therefore
/// announced protection while protecting the wrong branch on exactly the
/// workflow it mattered most for. `git branch -d` remains the real safety net —
/// it refuses an unmerged branch, and git refuses one checked out elsewhere.
#[test]
fn delete_branch_deletes_a_branch_origin_head_calls_the_default() {
    let fx = Fixture::new();
    let wt = fx.mkdir("wt-develop");
    let wt_path = wt.to_string_lossy().into_owned();
    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let git = MockGit::new(
        &wt_path,
        "/main",
        &two_worktrees("/main", &wt_path, "develop"),
    )
    .with_default_branch("develop");
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: true },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new(&wt_path);
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, &wt_path);
    let flags = CleanFlags {
        delete_branch: true,
        ..Default::default()
    };
    let outcome = clean_command(&d, &flags, OutputOptions::default()).unwrap();

    assert_eq!(outcome, Outcome::cd("/main"));
    assert!(git.calls_contain(&["-C", "/main", "branch", "-d", "--", "develop"]));
    let out = io.stderr_text();
    assert!(
        !out.contains("default branch"),
        "no default-branch message may survive: {out}"
    );
}

/// What it guarantees: the removal costs `clean` no git calls. The guard used to
/// resolve the default branch on every `--delete-branch` run.
#[test]
fn delete_branch_does_not_consult_origin_head() {
    let fx = Fixture::new();
    let wt = fx.mkdir("wt-feat");
    let wt_path = wt.to_string_lossy().into_owned();
    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let git = MockGit::new(&wt_path, "/main", &two_worktrees("/main", &wt_path, "feat"))
        .with_default_branch("develop");
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: true },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new(&wt_path);
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, &wt_path);
    let flags = CleanFlags {
        delete_branch: true,
        ..Default::default()
    };
    clean_command(&d, &flags, OutputOptions::default()).unwrap();

    assert!(git.calls_contain(&["-C", "/main", "branch", "-d", "--", "feat"]));
    assert!(
        !git.calls_contain(&["symbolic-ref"]),
        "resolving the default branch is no longer part of clean"
    );
}

// --- G-10: delete-branch 4-tier precedence boundaries ---
//
// Cascade (clean.rs `maybe_delete_branch`):
//   CLI --delete-branch > CLI --keep-branch > config.clean.delete_branch > false.
// The existing tests cover: --delete-branch deletes, --keep-branch beats config,
// and the default (nothing) does not delete. These add the missing boundaries.

/// Build a trusted `.vibe.toml` with `[clean] delete_branch = <val>` and return
/// the deps pieces. The config lives at the WORKTREE root (where clean loads it).
fn trusted_clean_config(
    fx: &Fixture,
    wt_path: &str,
    delete_branch: bool,
) -> (FakeIo, CleanTrustResolver) {
    use crate::hash::hash_content;
    use crate::settings::{AllowEntry, RepoId};
    use std::collections::HashMap;

    let content = format!("[clean]\ndelete_branch = {delete_branch}\n");
    std::fs::write(std::path::Path::new(wt_path).join(".vibe.toml"), &content).unwrap();

    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let mut settings = VibeSettings::default_settings();
    settings.permissions.allow.push(AllowEntry {
        repo_id: RepoId {
            remote_url: None,
            repo_root: Some(wt_path.to_string()),
        },
        relative_path: ".vibe.toml".into(),
        hashes: vec![hash_content(content.as_bytes())],
        skip_hash_check: None,
        config_semantics_rev: None,
        config_semantics_revs: None,
    });
    save_user_settings(&io, &settings, V).unwrap();

    let mut repos = HashMap::new();
    repos.insert(
        std::path::Path::new(wt_path)
            .join(".vibe.toml")
            .to_string_lossy()
            .into_owned(),
        RepoInfo {
            remote_url: None,
            repo_root: wt_path.to_string(),
            relative_path: ".vibe.toml".into(),
        },
    );
    (io, CleanTrustResolver { repos })
}

struct CleanTrustResolver {
    repos: std::collections::HashMap<String, RepoInfo>,
}
impl RepoResolver for CleanTrustResolver {
    fn repo_info(&self, path: &str) -> Option<RepoInfo> {
        self.repos.get(path).cloned()
    }
    fn hash_file(&self, path: &str) -> std::result::Result<String, String> {
        crate::hash::hash_file(path).map_err(|e| e.to_string())
    }
}

#[test]
fn config_delete_branch_true_deletes_when_no_flags() {
    // Tier 3: config.clean.delete_branch = true, no CLI flags → deletes.
    let fx = Fixture::new();
    let wt = fx.mkdir("wt-feat");
    let wt_path = wt.to_string_lossy().into_owned();
    let (io, resolver) = trusted_clean_config(&fx, &wt_path, true);

    let git = MockGit::new(&wt_path, "/main", &two_worktrees("/main", &wt_path, "feat"));
    let p = ScriptPrompt { confirm: true };
    let sin = FakeStdin::none();
    let fk = Fakes::new();
    let proc = FakeProcess::new(&wt_path);
    let d = CleanDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        prompt: &p,
        process: &proc,
        stdin: &sin,
        hook_runner: &fk.hooks,
        native: &fk.native,
        spawner: &fk.spawner,
        tracker: &fk.tracker,
        clock: &fk.clock,
        random: &fk.random,
        cwd: &wt_path,
        version: V,
    };
    clean_command(&d, &CleanFlags::default(), OutputOptions::default()).unwrap();
    assert!(git.calls_contain(&["-C", "/main", "branch", "-d", "--", "feat"]));
}

#[test]
fn cli_delete_branch_wins_over_config_keep() {
    // Tier 1 beats tier 3: CLI --delete-branch overrides config.delete_branch=false.
    let fx = Fixture::new();
    let wt = fx.mkdir("wt-feat");
    let wt_path = wt.to_string_lossy().into_owned();
    let (io, resolver) = trusted_clean_config(&fx, &wt_path, false);

    let git = MockGit::new(&wt_path, "/main", &two_worktrees("/main", &wt_path, "feat"));
    let p = ScriptPrompt { confirm: true };
    let sin = FakeStdin::none();
    let fk = Fakes::new();
    let proc = FakeProcess::new(&wt_path);
    let d = CleanDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        prompt: &p,
        process: &proc,
        stdin: &sin,
        hook_runner: &fk.hooks,
        native: &fk.native,
        spawner: &fk.spawner,
        tracker: &fk.tracker,
        clock: &fk.clock,
        random: &fk.random,
        cwd: &wt_path,
        version: V,
    };
    let flags = CleanFlags {
        delete_branch: true,
        ..Default::default()
    };
    clean_command(&d, &flags, OutputOptions::default()).unwrap();
    assert!(git.calls_contain(&["-C", "/main", "branch", "-d", "--", "feat"]));
}

#[test]
fn cli_delete_branch_wins_over_cli_keep_branch() {
    // Tier 1 beats tier 2: when BOTH flags are set, --delete-branch wins in the
    // cascade. (The binary rejects this combo up front; this asserts the
    // command-level precedence directly, defending the branch order.)
    let fx = Fixture::new();
    let wt = fx.mkdir("wt-feat");
    let wt_path = wt.to_string_lossy().into_owned();
    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let git = MockGit::new(&wt_path, "/main", &two_worktrees("/main", &wt_path, "feat"));
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: true },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new(&wt_path);
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, &wt_path);
    let flags = CleanFlags {
        delete_branch: true,
        keep_branch: true,
        ..Default::default()
    };
    clean_command(&d, &flags, OutputOptions::default()).unwrap();
    assert!(git.calls_contain(&["-C", "/main", "branch", "-d", "--", "feat"]));
}

// --- chdir-to-main failure is fatal ---

#[test]
fn chdir_to_main_failure_is_fatal() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new(
        "/wt/feat",
        "/main",
        &two_worktrees("/main", "/wt/feat", "feat"),
    );
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: true },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::failing_to("/wt/feat", "/main");
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, "/wt/feat");
    let err = clean_command(&d, &CleanFlags::default(), OutputOptions::default()).unwrap_err();
    assert!(matches!(err, VibeError::AlreadyReported));
    assert!(io.stderr_text().contains("Cannot change to main worktree"));
}

// --- already-removed race ---

#[test]
fn already_removed_worktree_cds_to_main() {
    let (_fx, io) = io_with_home();
    // get_worktree_by_path returns None (current path not in the list).
    let git = MockGit::new(
        "/wt/gone",
        "/main",
        "worktree /main\nbranch refs/heads/main\n\n",
    );
    let (r, p, sin, fk) = (
        NoResolver,
        ScriptPrompt { confirm: true },
        FakeStdin::none(),
        Fakes::new(),
    );
    let proc = FakeProcess::new("/wt/gone");
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, "/wt/gone");
    let outcome = clean_command(&d, &CleanFlags::default(), OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::cd("/main"));
    assert!(io.stderr_text().contains("Worktree already removed."));
}

// --- pre_clean / post_clean hook cwds ---

#[test]
fn pre_clean_runs_in_worktree_post_clean_in_main() {
    use crate::hash::hash_content;
    use crate::settings::{AllowEntry, RepoId};
    use std::collections::HashMap;

    let fx = Fixture::new();
    let wt = fx.mkdir("wt-feat");
    let wt_path = wt.to_string_lossy().into_owned();
    let content = "[hooks]\npre_clean = [\"echo pre\"]\npost_clean = [\"echo post\"]\n";
    std::fs::write(wt.join(".vibe.toml"), content).unwrap();

    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let mut settings = VibeSettings::default_settings();
    settings.permissions.allow.push(AllowEntry {
        repo_id: RepoId {
            remote_url: None,
            repo_root: Some(wt_path.clone()),
        },
        relative_path: ".vibe.toml".into(),
        hashes: vec![hash_content(content.as_bytes())],
        skip_hash_check: None,
        config_semantics_rev: None,
        config_semantics_revs: None,
    });
    save_user_settings(&io, &settings, V).unwrap();

    let mut repos = HashMap::new();
    repos.insert(
        wt.join(".vibe.toml").to_string_lossy().into_owned(),
        RepoInfo {
            remote_url: None,
            repo_root: wt_path.clone(),
            relative_path: ".vibe.toml".into(),
        },
    );
    struct TrustResolver {
        repos: HashMap<String, RepoInfo>,
    }
    impl RepoResolver for TrustResolver {
        fn repo_info(&self, path: &str) -> Option<RepoInfo> {
            self.repos.get(path).cloned()
        }
        fn hash_file(&self, path: &str) -> std::result::Result<String, String> {
            crate::hash::hash_file(path).map_err(|e| e.to_string())
        }
    }
    let resolver = TrustResolver { repos };

    let git = MockGit::new(&wt_path, "/main", &two_worktrees("/main", &wt_path, "feat"));
    let p = ScriptPrompt { confirm: true };
    let sin = FakeStdin::none();
    let fk = Fakes::new();
    let proc = FakeProcess::new(&wt_path);
    let d = CleanDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        prompt: &p,
        process: &proc,
        stdin: &sin,
        hook_runner: &fk.hooks,
        native: &fk.native,
        spawner: &fk.spawner,
        tracker: &fk.tracker,
        clock: &fk.clock,
        random: &fk.random,
        cwd: &wt_path,
        version: V,
    };
    clean_command(&d, &CleanFlags::default(), OutputOptions::default()).unwrap();

    let calls = fk.hooks.calls.borrow();
    assert_eq!(calls.len(), 2);
    // pre_clean in the worktree, post_clean in main.
    assert_eq!(calls[0].0, "echo pre");
    assert_eq!(calls[0].1, wt_path);
    assert_eq!(calls[1].0, "echo post");
    assert_eq!(calls[1].1, "/main");
}

// --- issue #601: a failing hook must not swallow the cd ---

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

/// A worktree directory holding a TRUSTED `.vibe.toml` with `content`.
/// Returns (fixture, io, resolver, worktree path).
fn trusted_worktree_config(content: &str) -> (Fixture, FakeIo, TrustResolver, String) {
    use crate::hash::hash_content;
    use crate::settings::{AllowEntry, RepoId};
    use std::collections::HashMap;

    let fx = Fixture::new();
    let wt = fx.mkdir("wt-feat");
    let wt_path = wt.to_string_lossy().into_owned();
    std::fs::write(wt.join(".vibe.toml"), content).unwrap();

    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let mut settings = VibeSettings::default_settings();
    settings.permissions.allow.push(AllowEntry {
        repo_id: RepoId {
            remote_url: None,
            repo_root: Some(wt_path.clone()),
        },
        relative_path: ".vibe.toml".into(),
        hashes: vec![hash_content(content.as_bytes())],
        skip_hash_check: None,
        config_semantics_rev: None,
        config_semantics_revs: None,
    });
    save_user_settings(&io, &settings, V).unwrap();

    let mut repos = HashMap::new();
    repos.insert(
        wt.join(".vibe.toml").to_string_lossy().into_owned(),
        RepoInfo {
            remote_url: None,
            repo_root: wt_path.clone(),
            relative_path: ".vibe.toml".into(),
        },
    );
    (fx, io, TrustResolver { repos }, wt_path)
}

/// Drive `clean` over a trusted config with a hook runner failing `fail_suffix`.
fn clean_with_failing_hook(
    content: &str,
    fail_suffix: &str,
    flags: &CleanFlags,
) -> (Fixture, FakeIo, String, MockGit, Fakes, Result<Outcome>) {
    let (fx, io, resolver, wt_path) = trusted_worktree_config(content);
    let git = MockGit::new(&wt_path, "/main", &two_worktrees("/main", &wt_path, "feat"));
    let p = ScriptPrompt { confirm: true };
    let sin = FakeStdin::none();
    let fk = Fakes {
        hooks: FakeHookRunner::failing_on(fail_suffix, 3, "hook stderr detail"),
        ..Fakes::new()
    };
    let proc = FakeProcess::new(&wt_path);
    let result = {
        let d = CleanDeps {
            io: &io,
            git: &git,
            resolver: &resolver,
            prompt: &p,
            process: &proc,
            stdin: &sin,
            hook_runner: &fk.hooks,
            native: &fk.native,
            spawner: &fk.spawner,
            tracker: &fk.tracker,
            clock: &fk.clock,
            random: &fk.random,
            cwd: &wt_path,
            version: V,
        };
        clean_command(&d, flags, OutputOptions::default())
    };
    (fx, io, wt_path, git, fk, result)
}

/// A failing `pre_clean` hook aborts before anything is destroyed: no removal,
/// no cd (the shell stays in the still-existing worktree), exit 0.
#[test]
fn failing_pre_clean_hook_aborts_without_removal_and_returns_none() {
    let content = "[hooks]\npre_clean = [\"boom\"]\npost_clean = [\"echo post\"]\n";
    let (_fx, io, wt_path, git, fk, result) =
        clean_with_failing_hook(content, "boom", &CleanFlags::default());

    let outcome = result.expect("a failing hook must not fail the command");
    assert_eq!(outcome, Outcome::none());
    assert!(!git.calls_contain(&["-C", "/main", "worktree", "remove"]));
    assert!(fk.native.trash_calls.borrow().is_empty());
    assert_eq!(
        fk.hooks.calls.borrow().len(),
        1,
        "post_clean must not run after the abort"
    );
    assert!(io
        .stderr_text()
        .contains("Warning: Hook \"boom\" failed: exit code 3"));
    let _ = wt_path;
}

/// A failing `post_clean` hook only warns: the worktree is already gone, so the
/// cd to main must still be emitted (issue #601).
#[test]
fn failing_post_clean_hook_still_returns_cd_to_main() {
    let content = "[hooks]\npost_clean = [\"boom\"]\n";
    let (_fx, io, _wt_path, git, _fk, result) =
        clean_with_failing_hook(content, "boom", &CleanFlags::default());

    let outcome = result.expect("a failing hook must not fail the command");
    assert_eq!(outcome, Outcome::cd("/main"));
    assert!(git.calls_contain(&["-C", "/main", "worktree", "remove"]));
    let stderr = io.stderr_text();
    assert!(
        stderr.contains("Warning: Hook \"boom\" failed: exit code 3"),
        "stderr: {stderr}"
    );
    assert!(stderr.contains("has been removed."), "stderr: {stderr}");
}

/// Branch deletion is part of the already-succeeded removal, so a failing
/// `post_clean` hook must not skip it.
#[test]
fn failing_post_clean_hook_still_deletes_branch_when_configured() {
    let content = "[hooks]\npost_clean = [\"boom\"]\n[clean]\ndelete_branch = true\n";
    let (_fx, _io, _wt_path, git, _fk, result) =
        clean_with_failing_hook(content, "boom", &CleanFlags::default());

    result.expect("a failing hook must not fail the command");
    assert!(git.calls_contain(&["-C", "/main", "branch", "-d", "--", "feat"]));
}

/// Hook mode keeps the same split: a failing `pre_clean` skips the removal.
#[test]
fn hook_mode_failing_pre_clean_skips_removal() {
    let content = "[hooks]\npre_clean = [\"boom\"]\n";
    let (_fx, io, resolver, wt_path) = trusted_worktree_config(content);
    let git = MockGit::new("/main", "/main", &two_worktrees("/main", &wt_path, "feat"));
    let p = ScriptPrompt { confirm: true };
    let json = serde_json::json!({ "worktree_path": &wt_path }).to_string();
    let sin = FakeStdin::text(&json);
    let fk = Fakes {
        hooks: FakeHookRunner::failing_on("boom", 3, "hook stderr detail"),
        ..Fakes::new()
    };
    let proc = FakeProcess::new("/main");
    let flags = CleanFlags {
        worktree_hook: true,
        ..Default::default()
    };
    let outcome = {
        let d = CleanDeps {
            io: &io,
            git: &git,
            resolver: &resolver,
            prompt: &p,
            process: &proc,
            stdin: &sin,
            hook_runner: &fk.hooks,
            native: &fk.native,
            spawner: &fk.spawner,
            tracker: &fk.tracker,
            clock: &fk.clock,
            random: &fk.random,
            cwd: "/main",
            version: V,
        };
        clean_command(&d, &flags, OutputOptions::default())
            .expect("a failing hook must not fail the command")
    };
    assert_eq!(outcome, Outcome::none());
    assert!(!git.calls_contain(&["-C", "/main", "worktree", "remove"]));
    assert!(io
        .stderr_text()
        .contains("Warning: Hook \"boom\" failed: exit code 3"));
}

/// Hook mode emits no cd either way, but a failing `post_clean` must still not
/// skip the branch deletion.
#[test]
fn hook_mode_failing_post_clean_still_returns_none_and_deletes_branch() {
    let content = "[hooks]\npost_clean = [\"boom\"]\n[clean]\ndelete_branch = true\n";
    let (_fx, io, resolver, wt_path) = trusted_worktree_config(content);
    let git = MockGit::new("/main", "/main", &two_worktrees("/main", &wt_path, "feat"));
    let p = ScriptPrompt { confirm: true };
    let json = serde_json::json!({ "worktree_path": &wt_path }).to_string();
    let sin = FakeStdin::text(&json);
    let fk = Fakes {
        hooks: FakeHookRunner::failing_on("boom", 3, "hook stderr detail"),
        ..Fakes::new()
    };
    let proc = FakeProcess::new("/main");
    let flags = CleanFlags {
        worktree_hook: true,
        ..Default::default()
    };
    let outcome = {
        let d = CleanDeps {
            io: &io,
            git: &git,
            resolver: &resolver,
            prompt: &p,
            process: &proc,
            stdin: &sin,
            hook_runner: &fk.hooks,
            native: &fk.native,
            spawner: &fk.spawner,
            tracker: &fk.tracker,
            clock: &fk.clock,
            random: &fk.random,
            cwd: "/main",
            version: V,
        };
        clean_command(&d, &flags, OutputOptions::default())
            .expect("a failing hook must not fail the command")
    };
    assert_eq!(outcome, Outcome::none());
    assert!(git.calls_contain(&["-C", "/main", "worktree", "remove"]));
    assert!(git.calls_contain(&["-C", "/main", "branch", "-d", "--", "feat"]));
    assert!(io
        .stderr_text()
        .contains("Warning: Hook \"boom\" failed: exit code 3"));
}

/// The downgrade is narrow: a non-hook fatal error from the same run (an
/// untrusted config) still fails at exit 1 with no cd.
#[test]
fn untrusted_config_stays_fatal_after_hook_downgrade() {
    let content = "[hooks]\npost_clean = [\"boom\"]\n";
    let (fx, io, mut resolver, wt_path) = trusted_worktree_config(content);
    let _ = &fx;
    // Drop the trust entry so `load_vibe_config` refuses the file.
    resolver.repos.clear();
    let git = MockGit::new(&wt_path, "/main", &two_worktrees("/main", &wt_path, "feat"));
    let p = ScriptPrompt { confirm: true };
    let sin = FakeStdin::none();
    let fk = Fakes::new();
    let proc = FakeProcess::new(&wt_path);
    let err = {
        let d = CleanDeps {
            io: &io,
            git: &git,
            resolver: &resolver,
            prompt: &p,
            process: &proc,
            stdin: &sin,
            hook_runner: &fk.hooks,
            native: &fk.native,
            spawner: &fk.spawner,
            tracker: &fk.tracker,
            clock: &fk.clock,
            random: &fk.random,
            cwd: &wt_path,
            version: V,
        };
        clean_command(&d, &CleanFlags::default(), OutputOptions::default()).unwrap_err()
    };
    assert_eq!(err.exit_code(), 1);
    assert!(!git.calls_contain(&["-C", "/main", "worktree", "remove"]));
}

// --- SECURITY #3: hook-mode containment check ---

#[test]
fn hook_mode_refuses_path_not_in_worktree_set() {
    let (_fx, io) = io_with_home();
    // stdin gives an absolute path that is NOT in the worktree list.
    let git = MockGit::new(
        "/anything",
        "/main",
        &two_worktrees("/main", "/wt/real", "feat"),
    );
    let (r, p, fk) = (NoResolver, ScriptPrompt { confirm: true }, Fakes::new());
    // Absolute on this host (the reader rejects relative paths outright) and
    // JSON-escaped, so the containment check — not the absoluteness check — is
    // what refuses it.
    let outside = serde_json::json!({ "worktree_path": fake_root_str("evil/outside") }).to_string();
    let sin = FakeStdin::text(&outside);
    let proc = FakeProcess::new("/main");
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, "/main");
    let flags = CleanFlags {
        worktree_hook: true,
        ..Default::default()
    };
    let outcome = clean_command(&d, &flags, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    assert!(io
        .stderr_text()
        .contains("refusing to clean a path not in the git worktree set"));
    // No removal attempted.
    assert!(!git.calls_contain(&["-C", "/main", "worktree", "remove"]));
    assert!(fk.native.trash_calls.borrow().is_empty());
}

#[test]
fn hook_mode_cleans_a_contained_path() {
    let fx = Fixture::new();
    let wt = fx.mkdir("wt-feat");
    let wt_path = wt.to_string_lossy().into_owned();
    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let git = MockGit::new("/main", "/main", &two_worktrees("/main", &wt_path, "feat"));
    let (r, p, fk) = (NoResolver, ScriptPrompt { confirm: true }, Fakes::new());
    // Built with a JSON serializer, not string interpolation: a Windows temp path
    // contains `\`, which is an escape introducer inside a JSON string.
    let json = serde_json::json!({ "worktree_path": &wt_path }).to_string();
    let sin = FakeStdin::text(&json);
    let proc = FakeProcess::new("/main");
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, "/main");
    let flags = CleanFlags {
        worktree_hook: true,
        ..Default::default()
    };
    let outcome = clean_command(&d, &flags, OutputOptions::default()).unwrap();
    // Hook mode emits no cd.
    assert_eq!(outcome, Outcome::none());
    // The contained path WAS removed (force, with `--`).
    assert!(git.calls_contain(&["-C", "/main", "worktree", "remove", "--force", "--", &wt_path]));
}

#[test]
fn hook_mode_requires_path_via_stdin() {
    let (_fx, io) = io_with_home();
    let git = MockGit::new(
        "/main",
        "/main",
        &two_worktrees("/main", "/wt/feat", "feat"),
    );
    let (r, p, fk) = (NoResolver, ScriptPrompt { confirm: true }, Fakes::new());
    let sin = FakeStdin::none();
    let proc = FakeProcess::new("/main");
    let d = deps(&io, &git, &r, &p, &proc, &sin, &fk, "/main");
    let flags = CleanFlags {
        worktree_hook: true,
        ..Default::default()
    };
    let err = clean_command(&d, &flags, OutputOptions::default()).unwrap_err();
    assert!(matches!(err, VibeError::AlreadyReported));
    assert!(io
        .stderr_text()
        .contains("requires worktree_path via stdin"));
}
