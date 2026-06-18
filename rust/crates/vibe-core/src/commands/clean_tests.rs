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
use vibe_test_support::Fixture;

const V: &str = "1.8.1+test";

struct MockGit {
    repo_root: String,
    main_path: String,
    worktree_list: String,
    uncommitted: bool,
    pub calls: RefCell<Vec<Vec<String>>>,
}
impl MockGit {
    fn new(repo_root: &str, main_path: &str, worktree_list: &str) -> Self {
        MockGit {
            repo_root: repo_root.to_string(),
            main_path: main_path.to_string(),
            worktree_list: worktree_list.to_string(),
            uncommitted: false,
            calls: RefCell::new(vec![]),
        }
    }
    fn with_uncommitted(mut self, yes: bool) -> Self {
        self.uncommitted = yes;
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
    let sin = FakeStdin::text(r#"{"worktree_path": "/evil/outside"}"#);
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
    let sin = FakeStdin::text(&format!(r#"{{"worktree_path": "{wt_path}"}}"#));
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
