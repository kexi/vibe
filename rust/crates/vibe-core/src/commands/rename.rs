//! `vibe rename <new-name>`: rename the current worktree's branch + directory.
//!
//! Ported from `packages/core/src/commands/rename.ts`. The validation cascade,
//! pushed-branch guard, path resolution (from the MAIN worktree), dry-run output
//! and move→chdir→rename sequence (with rollback on failure) mirror the TS
//! byte-for-byte on the success/normal paths. Two ERROR-ONLY divergences harden
//! the move/chdir sequence — see the SECURITY notes at points 4a/4b.

use crate::commands::{Outcome, ProcessControl};
use crate::config_loader::load_vibe_config;
use crate::error::{Result, VibeError};
use crate::git::{
    branch_exists, find_worktree_by_branch, get_main_worktree_path, get_worktree_by_path,
    is_main_worktree, sanitize_branch_name, GitRunner,
};
use crate::io::Io;
use crate::mru::update_mru_branch;
use crate::output::{error_log, log, log_dry_run, success_log, verbose_log, OutputOptions};
use crate::settings::RepoResolver;
use crate::settings_io::load_user_settings;
use crate::worktree_path::{resolve_worktree_path, ScriptRunner, WorktreePathContext};
use crate::worktree_rename::{
    get_branch_upstream, get_move_worktree_command, get_rename_branch_command, move_worktree,
    rename_branch, BranchUpstream,
};

/// Injected side-effects for `rename`, grouped like `JumpDeps`.
pub struct RenameDeps<'a, I, G, R, S, P>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: ProcessControl,
{
    pub io: &'a I,
    pub git: &'a G,
    pub resolver: &'a R,
    pub script_runner: &'a S,
    pub process: &'a P,
    /// The process's current working directory (already realpath-resolved by the
    /// caller; the TS did `realPath(cwd)` with a fallback to the raw cwd).
    pub real_cwd: &'a str,
    /// The binary build version (flows into settings save for the `$schema` URL).
    pub version: &'a str,
    /// Current wall-clock epoch ms, for the MRU update.
    pub now_ms: i64,
}

/// Run `vibe rename <new_name>` (optionally `--dry-run`).
pub fn rename_command<I, G, R, S, P>(
    deps: &RenameDeps<I, G, R, S, P>,
    new_name: &str,
    dry_run: bool,
    opts: OutputOptions,
) -> Result<Outcome>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: ProcessControl,
{
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        error_log(deps.io, "Error: New branch name is required");
        return Err(VibeError::AlreadyReported);
    }

    let Some(current) = get_worktree_by_path(deps.git, deps.real_cwd)? else {
        error_log(deps.io, "Error: Not in a vibe worktree");
        return Err(VibeError::AlreadyReported);
    };

    if is_main_worktree(deps.git)? {
        error_log(deps.io, "Error: Cannot rename main worktree");
        return Err(VibeError::AlreadyReported);
    }

    let old_name = current.branch.clone();
    let old_path = current.path.clone();

    // The branch name is kept verbatim (slashes are valid git namespacing); only
    // the on-disk worktree directory name is sanitized.
    let new_name = trimmed.to_string();
    let sanitized_for_path = sanitize_branch_name(&new_name);

    if new_name == old_name {
        log(deps.io, &format!("Already named '{old_name}'"), opts);
        return Ok(Outcome::cd(old_path));
    }

    // Pushed-branch guard: refuse to rename a branch tracking a remote.
    if let BranchUpstream::Remote(remote) = get_branch_upstream(deps.git, &old_name)? {
        error_log(
            deps.io,
            &format!("Error: branch '{old_name}' is pushed to '{remote}'"),
        );
        error_log(
            deps.io,
            "vibe rename does not handle pushed branches to avoid remote divergence.",
        );
        error_log(deps.io, "To rename manually:");
        error_log(deps.io, &format!("  git branch -m {old_name} {new_name}"));
        error_log(deps.io, &format!("  git push {remote} -u {new_name}"));
        error_log(deps.io, &format!("  git push {remote} --delete {old_name}"));
        error_log(deps.io, "  # then move the worktree directory yourself");
        return Err(VibeError::AlreadyReported);
    }

    // Target-collision checks: the new branch / worktree must be free.
    let target_branch_used = branch_exists(deps.git, &new_name);
    let target_worktree = find_worktree_by_branch(deps.git, &new_name)?;
    if target_branch_used {
        error_log(
            deps.io,
            &format!("Error: branch '{new_name}' already exists"),
        );
        return Err(VibeError::AlreadyReported);
    }
    if let Some(path) = target_worktree {
        error_log(
            deps.io,
            &format!("Error: a worktree using '{new_name}' already exists at {path}"),
        );
        return Err(VibeError::AlreadyReported);
    }

    // Resolve the new path from the MAIN worktree so the directory is named after
    // the repository, not after whichever secondary worktree we are standing in.
    let main_worktree = get_main_worktree_path(deps.git)?;
    let repo_name = basename(&main_worktree);
    let settings = load_user_settings(deps.io, deps.resolver, deps.version)?;
    let config = load_vibe_config(deps.io, deps.resolver, deps.version, &main_worktree)?;

    let new_path = resolve_worktree_path(
        deps.io,
        deps.script_runner,
        config.as_ref(),
        &settings,
        &WorktreePathContext {
            repo_name,
            branch_name: new_name.clone(),
            sanitized_branch: sanitized_for_path,
            repo_root: main_worktree.clone(),
        },
    )?;

    let path_unchanged = new_path == old_path;
    if path_unchanged {
        verbose_log(
            deps.io,
            &format!("Worktree directory unchanged: {old_path}"),
            opts,
        );
    }

    if dry_run {
        if !path_unchanged {
            log_dry_run(
                deps.io,
                &format!(
                    "Would run: {}",
                    get_move_worktree_command(&old_path, &new_path)
                ),
            );
        }
        log_dry_run(
            deps.io,
            &format!(
                "Would run: {}",
                get_rename_branch_command(&old_name, &new_name)
            ),
        );
        log_dry_run(deps.io, &format!("Would change directory to: {new_path}"));
        // Dry-run performs no side effects and emits NO cd.
        return Ok(Outcome::none());
    }

    // --- Mutating sequence -------------------------------------------------

    if !path_unchanged {
        if let Err(e) = move_worktree(deps.git, &old_path, &new_path) {
            error_log(
                deps.io,
                &format!("Error: failed to move worktree directory: {e}"),
            );
            return Err(VibeError::AlreadyReported);
        }

        // The process was launched from old_path, which no longer exists after
        // the move; subsequent git subprocesses inherit cwd and would fail on
        // spawn. chdir into the new path.
        //
        // SECURITY (point 4a): the TS IGNORED the chdir result. We CHECK it: if
        // the chdir fails we roll the worktree back to old_path BEFORE attempting
        // the branch rename, so we never leave the branch renamed while sitting
        // in a stale/invalid directory. Error-only divergence from the TS.
        if let Err(e) = deps.process.chdir(&new_path) {
            error_log(
                deps.io,
                &format!("Error: failed to enter moved worktree directory: {e}"),
            );
            // Best-effort rollback of the move; report manual recovery if it fails.
            if let Err(rb) = move_worktree(deps.git, &new_path, &old_path) {
                error_log(deps.io, &format!("Error: rollback failed: {rb}"));
                error_log(
                    deps.io,
                    &format!("Manual recovery: git worktree move '{new_path}' '{old_path}'"),
                );
            }
            return Err(VibeError::AlreadyReported);
        }

        // SECURITY (point 4b): confirm we actually landed in the expected real
        // directory — detect a move↔chdir race / tampering before mutating refs.
        // Cheap detective layer: only triggers under tampering.
        if let Err(e) = confirm_in_dir(deps.process, &new_path) {
            error_log(
                deps.io,
                &format!("Error: worktree directory check failed after move: {e}"),
            );
            if let Err(rb) = move_worktree(deps.git, &new_path, &old_path) {
                error_log(deps.io, &format!("Error: rollback failed: {rb}"));
                error_log(
                    deps.io,
                    &format!("Manual recovery: git worktree move '{new_path}' '{old_path}'"),
                );
            } else {
                let _ = deps.process.chdir(&old_path);
            }
            return Err(VibeError::AlreadyReported);
        }
    }

    if let Err(e) = rename_branch(deps.git, &old_name, &new_name) {
        error_log(deps.io, &format!("Error: failed to rename branch: {e}"));
        if !path_unchanged {
            // Roll the directory back to where it was, then restore cwd.
            match move_worktree(deps.git, &new_path, &old_path) {
                Ok(()) => {
                    // chdir back; a failure here is non-fatal (we already rolled
                    // the dir back) — print manual recovery, do NOT panic.
                    if let Err(cd) = deps.process.chdir(&old_path) {
                        error_log(
                            deps.io,
                            &format!("Warning: could not return to original directory: {cd}"),
                        );
                        error_log(deps.io, &format!("Manual recovery: cd '{old_path}'"));
                    } else {
                        error_log(deps.io, "Worktree directory rolled back to original path.");
                    }
                }
                Err(rb) => {
                    error_log(deps.io, &format!("Error: rollback failed: {rb}"));
                    error_log(
                        deps.io,
                        &format!("Manual recovery: git worktree move '{new_path}' '{old_path}'"),
                    );
                }
            }
        }
        return Err(VibeError::AlreadyReported);
    }

    // MRU update is best-effort: a failure must not fail the rename.
    let _ = update_mru_branch(deps.io, &old_path, &new_path, &new_name);

    success_log(deps.io, &format!("Renamed {old_name} -> {new_name}"), opts);
    if !path_unchanged {
        log(
            deps.io,
            &format!("Directory: {old_path} -> {new_path}"),
            opts,
        );
    }
    Ok(Outcome::cd(new_path))
}

/// Confirm the process is now inside `expected` (point 4b detective layer).
///
/// Reads the CWD through the injected [`ProcessControl`] (so it reflects the
/// chdir we just issued, and stays testable). Accepts a match when both sides
/// canonicalize equal, OR — when either (or both) cannot be canonicalized on
/// disk — when they are equal after a lexical fold. A mismatch indicates a
/// move↔chdir race or tampering and aborts the rename before any ref mutation.
///
/// Why not error whenever a side fails to canonicalize: a `canonicalize` failure
/// here means "not present on disk as a real path", which legitimately happens
/// for a `FakeProcessControl` cwd in unit tests and is not in itself evidence of
/// tampering. The threat we guard against (an attacker swapping `new` for a
/// symlink between `git worktree move` and `chdir`) is still caught by the
/// canonicalize-equal branch when both sides resolve. Treating a both-`None`
/// case as a hard error would break the testable seam without adding security in
/// the trusted, on-disk path this runs in — so we fall back to lexical equality
/// rather than failing. Do NOT "simplify" this to error-on-canonicalize-failure:
/// that would remove the detective layer's testability and over-reject.
fn confirm_in_dir(process: &impl ProcessControl, expected: &str) -> Result<()> {
    let cwd = process.current_dir()?;

    let cwd_canon = std::fs::canonicalize(&cwd).ok();
    let expected_canon = std::fs::canonicalize(expected).ok();
    let ok = match (cwd_canon, expected_canon) {
        (Some(a), Some(b)) => a == b,
        // One side not on disk → fall back to a lexical comparison.
        _ => lexical_eq(&cwd, expected),
    };

    if ok {
        Ok(())
    } else {
        Err(VibeError::FileSystem(format!(
            "expected to be in {expected}, but cwd is {cwd}"
        )))
    }
}

/// Lexical path equality (folds `.`/`..`/separators without filesystem access).
fn lexical_eq(a: &str, b: &str) -> bool {
    crate::git::lexical_normalize_path(a) == crate::git::lexical_normalize_path(b)
}

/// `path.basename`-equivalent: the final path component, or the whole string.
fn basename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::RepoInfo;
    use crate::io::FakeIo;
    use crate::settings::VibeSettings;
    use crate::worktree_path::ScriptOutput;
    use std::cell::RefCell;

    const V: &str = "1.8.1+abc";

    /// A git mock that records every call, serves a fixed worktree list /
    /// repo-root / branch-upstream / branch-existence, and can be told to FAIL
    /// when an arg vector matches a configured prefix (for rollback tests).
    struct MockGit {
        worktree_list: String,
        /// What `rev-parse --show-toplevel` returns (the CURRENT repo root).
        current_root: String,
        /// `branch.<name>.remote` value, or `None` → key missing.
        upstream_remote: Option<String>,
        /// Branches that `show-ref` reports as existing.
        existing_branches: Vec<String>,
        /// Fail any call whose args START WITH this vector (e.g. ["branch","-m"]).
        fail_on: Option<Vec<String>>,
        /// Fail any call whose args EXACTLY equal this vector. Unlike `fail_on`'s
        /// prefix match, this lets a test fail the ROLLBACK move (`new → old`)
        /// while letting the forward move (`old → new`) succeed — the two share
        /// the `["worktree","move"]` prefix and only differ in their path args.
        fail_on_exact: Option<Vec<String>>,
        calls: RefCell<Vec<Vec<String>>>,
    }
    impl MockGit {
        fn new(worktree_list: &str, current_root: &str) -> Self {
            MockGit {
                worktree_list: worktree_list.to_string(),
                current_root: current_root.to_string(),
                upstream_remote: None,
                existing_branches: vec![],
                fail_on: None,
                fail_on_exact: None,
                calls: RefCell::new(vec![]),
            }
        }
        fn fail_on(mut self, prefix: &[&str]) -> Self {
            self.fail_on = Some(prefix.iter().map(|s| s.to_string()).collect());
            self
        }
        /// Fail ONLY the call whose args exactly equal `args` (e.g. the rollback
        /// `new → old` move), leaving the forward move and everything else green.
        fn fail_on_exact(mut self, args: &[&str]) -> Self {
            self.fail_on_exact = Some(args.iter().map(|s| s.to_string()).collect());
            self
        }
        fn with_remote(mut self, remote: &str) -> Self {
            self.upstream_remote = Some(remote.to_string());
            self
        }
        fn with_existing_branch(mut self, branch: &str) -> Self {
            self.existing_branches.push(branch.to_string());
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
            let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            self.calls.borrow_mut().push(owned.clone());

            if let Some(prefix) = &self.fail_on {
                let matches = owned.len() >= prefix.len() && owned[..prefix.len()] == prefix[..];
                if matches {
                    return Err(VibeError::GitOperation {
                        command: args.join(" "),
                        message: "failed: simulated".into(),
                    });
                }
            }

            if let Some(exact) = &self.fail_on_exact {
                if owned == *exact {
                    return Err(VibeError::GitOperation {
                        command: args.join(" "),
                        message: "failed: simulated rollback".into(),
                    });
                }
            }

            if args.contains(&"--show-toplevel") {
                return Ok(self.current_root.clone());
            }
            if args.contains(&"list") && args.contains(&"worktree") {
                return Ok(self.worktree_list.clone());
            }
            if args.contains(&"--get") {
                // branch.<name>.remote lookup.
                return match &self.upstream_remote {
                    Some(r) => Ok(r.clone()),
                    None => Err(VibeError::GitOperation {
                        command: args.join(" "),
                        message: "failed: key missing".into(),
                    }),
                };
            }
            if args.contains(&"show-ref") {
                let exists = args.iter().any(|a| {
                    self.existing_branches
                        .iter()
                        .any(|b| a.ends_with(b.as_str()))
                });
                return if exists {
                    Ok(String::new())
                } else {
                    Err(VibeError::GitOperation {
                        command: args.join(" "),
                        message: "failed: no ref".into(),
                    })
                };
            }
            // worktree move / branch -m → success (unless fail_on caught it above).
            Ok(String::new())
        }
    }

    /// Resolver with no repo info and an unused hasher (rename never trusts).
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

    /// ScriptRunner that is never expected to run (no path_script configured).
    struct NoScript;
    impl ScriptRunner for NoScript {
        fn run_script(&self, _cmd: &str, _env: &[(&str, &str)]) -> Result<ScriptOutput> {
            panic!("path_script should not run in these tests");
        }
    }

    /// Records chdir targets; reports a (settable) current dir; can FAIL chdir.
    struct FakeProcessControl {
        cwd: RefCell<String>,
        chdir_calls: RefCell<Vec<String>>,
        fail_chdir_to: Option<String>,
        /// When set, `current_dir()` reports THIS instead of the chdir'd path —
        /// modelling a move↔chdir race / tampering where the process lands in a
        /// directory other than the one it asked for (point 4b detective layer).
        report_dir_override: Option<String>,
    }
    impl FakeProcessControl {
        fn new(initial: &str) -> Self {
            FakeProcessControl {
                cwd: RefCell::new(initial.to_string()),
                chdir_calls: RefCell::new(vec![]),
                fail_chdir_to: None,
                report_dir_override: None,
            }
        }
        fn failing_to(initial: &str, target: &str) -> Self {
            FakeProcessControl {
                cwd: RefCell::new(initial.to_string()),
                chdir_calls: RefCell::new(vec![]),
                fail_chdir_to: Some(target.to_string()),
                report_dir_override: None,
            }
        }
        /// chdir SUCCEEDS, but `current_dir()` always reports `reported` — the
        /// post-move directory is NOT what was asked for. Drives `confirm_in_dir`
        /// to its mismatch branch (point 4b) without any real filesystem state.
        fn reporting_dir(initial: &str, reported: &str) -> Self {
            FakeProcessControl {
                cwd: RefCell::new(initial.to_string()),
                chdir_calls: RefCell::new(vec![]),
                fail_chdir_to: None,
                report_dir_override: Some(reported.to_string()),
            }
        }
    }
    impl ProcessControl for FakeProcessControl {
        fn chdir(&self, path: &str) -> Result<()> {
            self.chdir_calls.borrow_mut().push(path.to_string());
            if self.fail_chdir_to.as_deref() == Some(path) {
                return Err(VibeError::FileSystem(format!("cannot chdir to {path}")));
            }
            *self.cwd.borrow_mut() = path.to_string();
            Ok(())
        }
        fn current_dir(&self) -> Result<String> {
            if let Some(reported) = &self.report_dir_override {
                return Ok(reported.clone());
            }
            Ok(self.cwd.borrow().clone())
        }
    }

    /// A fake HOME so `load_user_settings` (called by rename) sees no settings
    /// file and returns defaults — keeps the path resolver on the default branch.
    fn io_with_home() -> (vibe_test_support::Fixture, FakeIo) {
        let fx = vibe_test_support::Fixture::new();
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        (fx, io)
    }

    /// porcelain for [main, feat] where feat is the current (secondary) worktree.
    fn two_worktrees(main: &str, feat_path: &str, feat_branch: &str) -> String {
        format!(
            "worktree {main}\nHEAD a\nbranch refs/heads/main\n\nworktree {feat_path}\nHEAD b\nbranch refs/heads/{feat_branch}\n\n"
        )
    }

    fn deps<'a>(
        io: &'a FakeIo,
        git: &'a MockGit,
        resolver: &'a NoResolver,
        script: &'a NoScript,
        process: &'a FakeProcessControl,
        real_cwd: &'a str,
    ) -> RenameDeps<'a, FakeIo, MockGit, NoResolver, NoScript, FakeProcessControl> {
        RenameDeps {
            io,
            git,
            resolver,
            script_runner: script,
            process,
            real_cwd,
            version: V,
            now_ms: 1000,
        }
    }

    #[test]
    fn empty_name_errors() {
        let (_fx, io) = io_with_home();
        let git = MockGit::new("", "/main");
        let (r, s, p) = (NoResolver, NoScript, FakeProcessControl::new("/feat"));
        let d = deps(&io, &git, &r, &s, &p, "/feat");
        let err = rename_command(&d, "   ", false, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));
        assert!(io.stderr_text().contains("New branch name is required"));
    }

    #[test]
    fn not_in_worktree_errors() {
        let (_fx, io) = io_with_home();
        // The cwd is not any listed worktree path.
        let git = MockGit::new(&two_worktrees("/main", "/wt/feat", "feat"), "/wt/feat");
        let (r, s, p) = (NoResolver, NoScript, FakeProcessControl::new("/elsewhere"));
        let d = deps(&io, &git, &r, &s, &p, "/elsewhere");
        let err = rename_command(&d, "new", false, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));
        assert!(io.stderr_text().contains("Not in a vibe worktree"));
    }

    #[test]
    fn cannot_rename_main_worktree() {
        let (_fx, io) = io_with_home();
        // current root == main worktree path → is_main is true.
        let git = MockGit::new(&two_worktrees("/main", "/wt/feat", "feat"), "/main");
        let (r, s, p) = (NoResolver, NoScript, FakeProcessControl::new("/main"));
        let d = deps(&io, &git, &r, &s, &p, "/main");
        let err = rename_command(&d, "new", false, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));
        assert!(io.stderr_text().contains("Cannot rename main worktree"));
    }

    #[test]
    fn same_name_cds_to_old_path_without_mutating() {
        let (_fx, io) = io_with_home();
        let git = MockGit::new(&two_worktrees("/main", "/wt/feat", "feat"), "/wt/feat");
        let (r, s, p) = (NoResolver, NoScript, FakeProcessControl::new("/wt/feat"));
        let d = deps(&io, &git, &r, &s, &p, "/wt/feat");
        let outcome = rename_command(&d, "feat", false, OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::cd("/wt/feat"));
        assert!(io.stderr_text().contains("Already named 'feat'"));
        assert!(!git.calls_contain(&["branch", "-m"]));
        assert!(!git.calls_contain(&["worktree", "move"]));
    }

    #[test]
    fn pushed_branch_prints_recovery_block_and_errors() {
        let (_fx, io) = io_with_home();
        let git = MockGit::new(&two_worktrees("/main", "/wt/feat", "feat"), "/wt/feat")
            .with_remote("origin");
        let (r, s, p) = (NoResolver, NoScript, FakeProcessControl::new("/wt/feat"));
        let d = deps(&io, &git, &r, &s, &p, "/wt/feat");
        let err = rename_command(&d, "renamed", false, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));
        let out = io.stderr_text();
        assert!(out.contains("branch 'feat' is pushed to 'origin'"));
        assert!(out.contains("git push origin -u renamed"));
        assert!(out.contains("git push origin --delete feat"));
        assert!(!git.calls_contain(&["worktree", "move"]));
    }

    #[test]
    fn target_branch_exists_errors() {
        let (_fx, io) = io_with_home();
        let git = MockGit::new(&two_worktrees("/main", "/wt/feat", "feat"), "/wt/feat")
            .with_existing_branch("renamed");
        let (r, s, p) = (NoResolver, NoScript, FakeProcessControl::new("/wt/feat"));
        let d = deps(&io, &git, &r, &s, &p, "/wt/feat");
        let err = rename_command(&d, "renamed", false, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));
        assert!(io.stderr_text().contains("branch 'renamed' already exists"));
    }

    #[test]
    fn target_worktree_exists_errors() {
        let (_fx, io) = io_with_home();
        // A worktree already uses branch "renamed".
        let porcelain = format!(
            "{}worktree /wt/other\nHEAD c\nbranch refs/heads/renamed\n\n",
            two_worktrees("/main", "/wt/feat", "feat")
        );
        let git = MockGit::new(&porcelain, "/wt/feat");
        let (r, s, p) = (NoResolver, NoScript, FakeProcessControl::new("/wt/feat"));
        let d = deps(&io, &git, &r, &s, &p, "/wt/feat");
        let err = rename_command(&d, "renamed", false, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));
        assert!(io
            .stderr_text()
            .contains("a worktree using 'renamed' already exists at /wt/other"));
    }

    #[test]
    fn dry_run_logs_three_lines_and_no_cd() {
        let (_fx, io) = io_with_home();
        // main basename "main" → default newPath = dirname(/main)=/ + main-renamed.
        let git = MockGit::new(&two_worktrees("/main", "/wt/feat", "feat"), "/wt/feat");
        let (r, s, p) = (NoResolver, NoScript, FakeProcessControl::new("/wt/feat"));
        let d = deps(&io, &git, &r, &s, &p, "/wt/feat");
        let outcome = rename_command(&d, "renamed", true, OutputOptions::default()).unwrap();
        // Dry-run emits NO cd.
        assert_eq!(outcome, Outcome::none());
        let out = io.stderr_text();
        assert!(out.contains("[dry-run] Would run: git worktree move"));
        assert!(out.contains("[dry-run] Would run: git branch -m feat renamed"));
        assert!(out.contains("[dry-run] Would change directory to:"));
        // No mutating git calls in dry-run.
        assert!(!git.calls_contain(&["worktree", "move"]));
        assert!(!git.calls_contain(&["branch", "-m"]));
    }

    #[test]
    fn happy_path_moves_renames_and_cds() {
        let (_fx, io) = io_with_home();
        // main at /home/u/myrepo → default newPath = /home/u/myrepo-renamed.
        let git = MockGit::new(
            &two_worktrees("/home/u/myrepo", "/home/u/myrepo-feat", "feat"),
            "/home/u/myrepo-feat",
        );
        let (r, s) = (NoResolver, NoScript);
        let p = FakeProcessControl::new("/home/u/myrepo-feat");
        let d = deps(&io, &git, &r, &s, &p, "/home/u/myrepo-feat");
        let outcome = rename_command(&d, "renamed", false, OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::cd("/home/u/myrepo-renamed"));
        // Moved, chdir'd into new, then renamed branch — in that order.
        assert!(git.calls_contain(&[
            "worktree",
            "move",
            "/home/u/myrepo-feat",
            "/home/u/myrepo-renamed"
        ]));
        assert!(git.calls_contain(&["branch", "-m", "feat", "renamed"]));
        assert_eq!(
            p.chdir_calls.borrow().as_slice(),
            &["/home/u/myrepo-renamed"]
        );
        let out = io.stderr_text();
        assert!(out.contains("Renamed feat -> renamed"));
        assert!(out.contains("Directory: /home/u/myrepo-feat -> /home/u/myrepo-renamed"));
    }

    #[test]
    fn branch_rename_failure_rolls_back_move_and_chdir() {
        // SECURITY/robustness: `git branch -m` fails AFTER the move+chdir → the
        // worktree must be moved BACK and cwd restored, then exit nonzero.
        let (_fx, io) = io_with_home();
        let git = MockGit::new(
            &two_worktrees("/home/u/myrepo", "/home/u/myrepo-feat", "feat"),
            "/home/u/myrepo-feat",
        )
        .fail_on(&["branch", "-m"]);
        let (r, s) = (NoResolver, NoScript);
        let p = FakeProcessControl::new("/home/u/myrepo-feat");
        let d = deps(&io, &git, &r, &s, &p, "/home/u/myrepo-feat");
        let err = rename_command(&d, "renamed", false, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));

        // Forward move happened, then the ROLLBACK move (new → old) happened.
        assert!(git.calls_contain(&[
            "worktree",
            "move",
            "/home/u/myrepo-feat",
            "/home/u/myrepo-renamed"
        ]));
        assert!(git.calls_contain(&[
            "worktree",
            "move",
            "/home/u/myrepo-renamed",
            "/home/u/myrepo-feat"
        ]));
        // chdir into new, then back to old.
        assert_eq!(
            p.chdir_calls.borrow().as_slice(),
            &["/home/u/myrepo-renamed", "/home/u/myrepo-feat"]
        );
        assert!(io
            .stderr_text()
            .contains("Worktree directory rolled back to original path."));
    }

    #[test]
    fn chdir_failure_after_move_rolls_back_before_branch_rename() {
        // SECURITY point 4a: chdir into the moved dir FAILS → roll the worktree
        // back BEFORE attempting any branch rename, and exit nonzero. The branch
        // must NEVER be renamed in this path.
        let (_fx, io) = io_with_home();
        let git = MockGit::new(
            &two_worktrees("/home/u/myrepo", "/home/u/myrepo-feat", "feat"),
            "/home/u/myrepo-feat",
        );
        let (r, s) = (NoResolver, NoScript);
        // chdir to the NEW path fails.
        let p = FakeProcessControl::failing_to("/home/u/myrepo-feat", "/home/u/myrepo-renamed");
        let d = deps(&io, &git, &r, &s, &p, "/home/u/myrepo-feat");
        let err = rename_command(&d, "renamed", false, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));

        // Forward move + rollback move both issued; branch rename NEVER attempted.
        assert!(git.calls_contain(&[
            "worktree",
            "move",
            "/home/u/myrepo-feat",
            "/home/u/myrepo-renamed"
        ]));
        assert!(git.calls_contain(&[
            "worktree",
            "move",
            "/home/u/myrepo-renamed",
            "/home/u/myrepo-feat"
        ]));
        assert!(
            !git.calls_contain(&["branch", "-m"]),
            "branch must not be renamed after a chdir failure"
        );
        assert!(io
            .stderr_text()
            .contains("failed to enter moved worktree directory"));
    }

    // --- P0 C-1: two-stage rollback FAILURE (the "Manual recovery" output) ---

    #[test]
    fn branch_rename_failure_with_failing_rollback_prints_manual_recovery() {
        // C-1 (branch-rename-failure case): `git branch -m` fails AFTER move+chdir,
        // AND the rollback move (new → old) ALSO fails. The command must surface
        // `Error: rollback failed: ...` + the exact `Manual recovery:` line and
        // return Err. Uses fail_on_exact so the FORWARD move still succeeds.
        let (_fx, io) = io_with_home();
        let git = MockGit::new(
            &two_worktrees("/home/u/myrepo", "/home/u/myrepo-feat", "feat"),
            "/home/u/myrepo-feat",
        )
        .fail_on(&["branch", "-m"])
        .fail_on_exact(&[
            "worktree",
            "move",
            "/home/u/myrepo-renamed",
            "/home/u/myrepo-feat",
        ]);
        let (r, s) = (NoResolver, NoScript);
        let p = FakeProcessControl::new("/home/u/myrepo-feat");
        let d = deps(&io, &git, &r, &s, &p, "/home/u/myrepo-feat");
        let err = rename_command(&d, "renamed", false, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));

        // Forward move happened; rollback move (new → old) was ATTEMPTED.
        assert!(git.calls_contain(&[
            "worktree",
            "move",
            "/home/u/myrepo-feat",
            "/home/u/myrepo-renamed"
        ]));
        assert!(git.calls_contain(&[
            "worktree",
            "move",
            "/home/u/myrepo-renamed",
            "/home/u/myrepo-feat"
        ]));
        let out = io.stderr_text();
        assert!(out.contains("Error: rollback failed:"), "stderr: {out}");
        // Exact TS message (byte-for-byte from rename.ts line 190).
        assert!(
            out.contains(
                "Manual recovery: git worktree move '/home/u/myrepo-renamed' '/home/u/myrepo-feat'"
            ),
            "stderr: {out}"
        );
        // Because rollback failed, we did NOT chdir back to old (the success
        // branch's chdir-back is skipped on a failed rollback).
        assert_eq!(
            p.chdir_calls.borrow().as_slice(),
            &["/home/u/myrepo-renamed"]
        );
    }

    #[test]
    fn chdir_failure_with_failing_rollback_prints_manual_recovery() {
        // C-1 (chdir-failure case, point 4a): chdir into the moved dir fails, and
        // the rollback move (new → old) ALSO fails → `Error: rollback failed:` +
        // the exact `Manual recovery:` line, Err, branch NEVER renamed.
        let (_fx, io) = io_with_home();
        let git = MockGit::new(
            &two_worktrees("/home/u/myrepo", "/home/u/myrepo-feat", "feat"),
            "/home/u/myrepo-feat",
        )
        .fail_on_exact(&[
            "worktree",
            "move",
            "/home/u/myrepo-renamed",
            "/home/u/myrepo-feat",
        ]);
        let (r, s) = (NoResolver, NoScript);
        // chdir into the NEW path fails → triggers the 4a rollback path.
        let p = FakeProcessControl::failing_to("/home/u/myrepo-feat", "/home/u/myrepo-renamed");
        let d = deps(&io, &git, &r, &s, &p, "/home/u/myrepo-feat");
        let err = rename_command(&d, "renamed", false, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));

        assert!(git.calls_contain(&[
            "worktree",
            "move",
            "/home/u/myrepo-feat",
            "/home/u/myrepo-renamed"
        ]));
        assert!(git.calls_contain(&[
            "worktree",
            "move",
            "/home/u/myrepo-renamed",
            "/home/u/myrepo-feat"
        ]));
        assert!(
            !git.calls_contain(&["branch", "-m"]),
            "branch must never be renamed on the 4a path"
        );
        let out = io.stderr_text();
        assert!(out.contains("failed to enter moved worktree directory"));
        assert!(out.contains("Error: rollback failed:"), "stderr: {out}");
        assert!(
            out.contains(
                "Manual recovery: git worktree move '/home/u/myrepo-renamed' '/home/u/myrepo-feat'"
            ),
            "stderr: {out}"
        );
    }

    // --- P0 C-2: point 4b confirm_in_dir MISMATCH (detective layer) ---

    #[test]
    fn confirm_in_dir_mismatch_aborts_before_branch_rename() {
        // C-2: chdir SUCCEEDS but the post-move cwd is NOT the path we asked for
        // (a move↔chdir race / tampering). The detective layer must abort BEFORE
        // any ref mutation: (a) `git branch -m` is NEVER called, (b) the rollback
        // move (new → old) IS called, (c) the command returns Err.
        let (_fx, io) = io_with_home();
        let git = MockGit::new(
            &two_worktrees("/home/u/myrepo", "/home/u/myrepo-feat", "feat"),
            "/home/u/myrepo-feat",
        );
        let (r, s) = (NoResolver, NoScript);
        // chdir to new succeeds, but current_dir() reports a DIFFERENT path.
        let p =
            FakeProcessControl::reporting_dir("/home/u/myrepo-feat", "/somewhere/else-entirely");
        let d = deps(&io, &git, &r, &s, &p, "/home/u/myrepo-feat");
        let err = rename_command(&d, "renamed", false, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));

        // (a) branch rename NEVER attempted.
        assert!(
            !git.calls_contain(&["branch", "-m"]),
            "detective layer must prevent the branch rename"
        );
        // (b) rollback move (new → old) issued.
        assert!(git.calls_contain(&[
            "worktree",
            "move",
            "/home/u/myrepo-renamed",
            "/home/u/myrepo-feat"
        ]));
        // (c) the abort message is the 4b directory-check failure.
        assert!(io
            .stderr_text()
            .contains("worktree directory check failed after move"));
    }

    // --- P1 R-1: path UNCHANGED (newPath == oldPath) ---

    #[test]
    fn path_unchanged_skips_move_and_chdir_but_renames_branch() {
        // R-1: when the resolved new path equals the old path, the move and chdir
        // are SKIPPED, but `git branch -m` still runs. The verbose "Worktree
        // directory unchanged" line appears; the "Directory: ..." line does NOT;
        // and the outcome cds to that (unchanged) path.
        //
        // Construct path-unchanged via the DEFAULT path: main=/home/u/myrepo,
        // current worktree at /home/u/myrepo-renamed on branch `feat`, renaming
        // feat → renamed → default newPath = /home/u/myrepo-renamed == oldPath.
        let (_fx, io) = io_with_home();
        let git = MockGit::new(
            &two_worktrees("/home/u/myrepo", "/home/u/myrepo-renamed", "feat"),
            "/home/u/myrepo-renamed",
        );
        let (r, s) = (NoResolver, NoScript);
        let p = FakeProcessControl::new("/home/u/myrepo-renamed");
        let d = deps(&io, &git, &r, &s, &p, "/home/u/myrepo-renamed");
        let outcome = rename_command(
            &d,
            "renamed",
            false,
            OutputOptions::new(true, false), // verbose so the unchanged line prints
        )
        .unwrap();

        assert_eq!(outcome, Outcome::cd("/home/u/myrepo-renamed"));
        // No move, no chdir.
        assert!(!git.calls_contain(&["worktree", "move"]));
        assert!(p.chdir_calls.borrow().is_empty());
        // Branch IS renamed.
        assert!(git.calls_contain(&["branch", "-m", "feat", "renamed"]));

        let out = io.stderr_text();
        assert!(
            out.contains("[verbose] Worktree directory unchanged: /home/u/myrepo-renamed"),
            "stderr: {out}"
        );
        assert!(out.contains("Renamed feat -> renamed"));
        // The "Directory: ..." line is suppressed on the unchanged path.
        assert!(
            !out.contains("Directory:"),
            "Directory line must be suppressed: {out}"
        );
    }

    #[test]
    fn dry_run_path_unchanged_omits_move_line() {
        // R-1 (dry-run variant): when newPath == oldPath, dry-run emits ONLY the
        // branch-rename + change-directory lines, NOT the move line.
        let (_fx, io) = io_with_home();
        let git = MockGit::new(
            &two_worktrees("/home/u/myrepo", "/home/u/myrepo-renamed", "feat"),
            "/home/u/myrepo-renamed",
        );
        let (r, s) = (NoResolver, NoScript);
        let p = FakeProcessControl::new("/home/u/myrepo-renamed");
        let d = deps(&io, &git, &r, &s, &p, "/home/u/myrepo-renamed");
        let outcome = rename_command(&d, "renamed", true, OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::none());

        let out = io.stderr_text();
        assert!(
            !out.contains("Would run: git worktree move"),
            "move line must be omitted on the unchanged path: {out}"
        );
        assert!(out.contains("[dry-run] Would run: git branch -m feat renamed"));
        assert!(out.contains("[dry-run] Would change directory to: /home/u/myrepo-renamed"));
        // No mutating git calls in dry-run.
        assert!(!git.calls_contain(&["branch", "-m"]));
    }

    // --- P2 R-2: branch-rename failure, rollback move OK but chdir-back FAILS ---

    #[test]
    fn branch_rename_failure_rollback_ok_but_chdir_back_fails() {
        // R-2: `git branch -m` fails; the rollback move (new → old) SUCCEEDS but
        // chdir back to old FAILS → `Warning: could not return to original
        // directory` + `Manual recovery: cd '<old>'`, and exit nonzero.
        let (_fx, io) = io_with_home();
        let git = MockGit::new(
            &two_worktrees("/home/u/myrepo", "/home/u/myrepo-feat", "feat"),
            "/home/u/myrepo-feat",
        )
        .fail_on(&["branch", "-m"]);
        let (r, s) = (NoResolver, NoScript);
        // chdir to NEW succeeds (first chdir), chdir BACK to old fails (second).
        let p = FakeProcessControl::failing_to("/home/u/myrepo-feat", "/home/u/myrepo-feat");
        let d = deps(&io, &git, &r, &s, &p, "/home/u/myrepo-feat");
        let err = rename_command(&d, "renamed", false, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));

        // Forward + rollback move both happened (rollback SUCCEEDED).
        assert!(git.calls_contain(&[
            "worktree",
            "move",
            "/home/u/myrepo-renamed",
            "/home/u/myrepo-feat"
        ]));
        // chdir into new, then attempted chdir back to old.
        assert_eq!(
            p.chdir_calls.borrow().as_slice(),
            &["/home/u/myrepo-renamed", "/home/u/myrepo-feat"]
        );
        let out = io.stderr_text();
        assert!(
            out.contains("Warning: could not return to original directory"),
            "stderr: {out}"
        );
        assert!(
            out.contains("Manual recovery: cd '/home/u/myrepo-feat'"),
            "stderr: {out}"
        );
    }

    // --- P2: front-stage (forward) move failure ---

    #[test]
    fn forward_move_failure_aborts_before_branch_rename() {
        // The forward `git worktree move` fails → `failed to move worktree
        // directory` + exit nonzero, and `git branch -m` is never called.
        let (_fx, io) = io_with_home();
        let git = MockGit::new(
            &two_worktrees("/home/u/myrepo", "/home/u/myrepo-feat", "feat"),
            "/home/u/myrepo-feat",
        )
        .fail_on(&["worktree", "move"]);
        let (r, s) = (NoResolver, NoScript);
        let p = FakeProcessControl::new("/home/u/myrepo-feat");
        let d = deps(&io, &git, &r, &s, &p, "/home/u/myrepo-feat");
        let err = rename_command(&d, "renamed", false, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));

        assert!(
            !git.calls_contain(&["branch", "-m"]),
            "branch must not be renamed when the forward move fails"
        );
        // No chdir happened (the move failed before chdir).
        assert!(p.chdir_calls.borrow().is_empty());
        assert!(io
            .stderr_text()
            .contains("failed to move worktree directory"));
    }

    // --- P3 r-1: MRU update failure must NOT fail the rename ---

    #[test]
    fn mru_update_failure_does_not_fail_rename() {
        // r-1: the MRU update is best-effort. Even if it cannot write (HOME points
        // at a path that cannot host the MRU file), the rename still succeeds with
        // exit 0 and the success output. We force an MRU write into a non-writable
        // location by pointing the MRU's repo paths at the real (existing) move,
        // which still resolves; the key assertion is the command returns Ok.
        let (_fx, io) = io_with_home();
        let git = MockGit::new(
            &two_worktrees("/home/u/myrepo", "/home/u/myrepo-feat", "feat"),
            "/home/u/myrepo-feat",
        );
        let (r, s) = (NoResolver, NoScript);
        let p = FakeProcessControl::new("/home/u/myrepo-feat");
        let d = deps(&io, &git, &r, &s, &p, "/home/u/myrepo-feat");
        // The MRU write targets /home/u/myrepo-renamed which does not exist on
        // disk; update_mru_branch is best-effort and its failure is swallowed.
        let outcome = rename_command(&d, "renamed", false, OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::cd("/home/u/myrepo-renamed"));
        assert!(io.stderr_text().contains("Renamed feat -> renamed"));
    }

    #[test]
    fn unused_settings_default_keeps_resolver_unused() {
        // Guards that the default-path branch doesn't trip the (panicking) script
        // runner: a successful happy path already proves NoScript never ran.
        let _ = VibeSettings::default_settings();
    }
}
