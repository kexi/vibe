//! Drive file + directory copies from glob-expanded patterns, with progress.
//!
//! Ported from `packages/core/src/utils/copy-runner.ts`. Files are copied
//! sequentially; directories are copied with a concurrency limit. The TS used
//! `Promise.all` over a shared index; here `copy_directories` spawns N worker
//! threads (`std::thread::scope`) pulling jobs from a shared `Mutex<VecDeque>`
//! (the `CopyExecutor`/`ProgressTracker` are `Send + Sync`), aggregating the
//! FIRST error like `Promise.all`. Per-FILE errors are caught + warned without
//! failing the whole op (TS parity for `copyFiles`).

use crate::config::VibeConfig;
use crate::copy::strategies::CopyExecutor;
use crate::copy::symlink::{without_symlinked, SymlinkedPaths};
use crate::glob::{expand_copy_patterns, expand_directory_patterns};
use crate::io::Io;
use crate::output::{log_dry_run, sanitize_for_display, warn_log};
use crate::progress::ProgressTracker;
use std::collections::VecDeque;
use std::sync::Mutex;

const DEFAULT_COPY_CONCURRENCY: i64 = 4;
const MAX_COPY_CONCURRENCY: i64 = 32;

/// Resolve copy concurrency: `VIBE_COPY_CONCURRENCY` env → `config.copy.concurrency`
/// → default 4, clamped to 1..=32.
///
/// An invalid env value warns and uses the DEFAULT (not the config value),
/// matching the TS `resolveCopyConcurrency`.
pub fn resolve_copy_concurrency(io: &impl Io, config: Option<&VibeConfig>) -> usize {
    if let Some(raw) = io.env("VIBE_COPY_CONCURRENCY") {
        match raw.trim().parse::<i64>() {
            Ok(n) if (1..=MAX_COPY_CONCURRENCY).contains(&n) => return n as usize,
            _ => {
                warn_log(
                    io,
                    &format!(
                        "Warning: Invalid VIBE_COPY_CONCURRENCY value '{raw}'. Must be an integer between 1 and {MAX_COPY_CONCURRENCY}. Using default: {DEFAULT_COPY_CONCURRENCY}"
                    ),
                );
                return DEFAULT_COPY_CONCURRENCY as usize;
            }
        }
    }

    let config_value = config
        .and_then(|c| c.copy.as_ref())
        .and_then(|c| c.concurrency);
    if let Some(n) = config_value {
        return n.clamp(1, MAX_COPY_CONCURRENCY) as usize;
    }

    DEFAULT_COPY_CONCURRENCY as usize
}

/// Join two path segments with `/` (forward-slash join, like node `path.join`).
fn join(a: &str, b: &str) -> String {
    std::path::Path::new(a)
        .join(b)
        .to_string_lossy()
        .into_owned()
}

/// Copy files matching `patterns` from `repo_root` into `worktree_path`.
///
/// Sequential, glob-expanded, one progress task per file. A per-file failure is
/// warned and the task failed, but the overall op continues (TS parity).
///
/// `symlinked` are the entries a link was actually CREATED for (not the raw
/// config); anything expanding to one of them (or under one) is dropped AFTER
/// expansion, because a glob only reveals the overlap once expanded — see
/// [`without_symlinked`], applied in [`copy_resolved_files`].
#[allow(clippy::too_many_arguments)]
pub fn copy_files(
    io: &impl Io,
    executor: &impl CopyExecutor,
    tracker: &dyn ProgressTracker,
    patterns: &[String],
    symlinked: &SymlinkedPaths,
    repo_root: &str,
    worktree_path: &str,
    dry_run: bool,
) {
    let files = expand_copy_patterns(io, patterns, repo_root);
    copy_resolved_files(
        io,
        executor,
        tracker,
        &files,
        symlinked,
        repo_root,
        worktree_path,
        dry_run,
    );
}

/// Copy an ALREADY-RESOLVED list of repo-relative files.
///
/// Split out of [`copy_files`] for sources that are not patterns: git-derived
/// paths (`[copy] untracked` / `modified`) are literal filenames, and a filename
/// containing `[`, `{`, `*` or `?` would be misread as a glob if it went through
/// the pattern expander. Callers that mix both concatenate the expanded patterns
/// with their literal paths and call this once, so a single progress phase and a
/// single dedup pass cover everything.
///
/// The symlink exclusion lives HERE rather than in [`copy_files`] so it covers
/// the git-derived candidates too: a file `git status` reports under a directory
/// that was actually symlinked is already visible through the link, and copying
/// it would write THROUGH the link back into the origin repo.
#[allow(clippy::too_many_arguments)]
pub fn copy_resolved_files(
    io: &impl Io,
    executor: &impl CopyExecutor,
    tracker: &dyn ProgressTracker,
    files: &[String],
    symlinked: &SymlinkedPaths,
    repo_root: &str,
    worktree_path: &str,
    dry_run: bool,
) {
    let files = &without_symlinked(symlinked, files);
    if files.is_empty() {
        return;
    }

    if dry_run {
        log_dry_run(io, "Would copy files:");
        for file in files {
            // Sanitized because this list can contain git-derived filenames
            // (`[copy] untracked` / `modified`), i.e. names an attacker who can
            // land a file in the repo controls; a raw ESC or bidi override here
            // would rewrite the terminal around the dry-run report.
            log_dry_run(io, &format!("  - {}", sanitize_for_display(file)));
        }
        return;
    }

    let phase = tracker.add_phase("Copying files");
    // The progress label goes straight to the terminal too, so it is sanitized
    // for the same reason as the dry-run list. Only the LABEL is sanitized — the
    // src/dest paths below are built from the untouched `file`, so a name
    // containing a control character is still copied verbatim.
    let task_ids: Vec<_> = files
        .iter()
        .map(|f| tracker.add_task(phase, &sanitize_for_display(f)))
        .collect();

    for (i, file) in files.iter().enumerate() {
        let src = join(repo_root, file);
        let dest = join(worktree_path, file);
        tracker.start_task(task_ids[i]);
        match executor.copy_file(&src, &dest) {
            Ok(()) => tracker.complete_task(task_ids[i]),
            Err(e) => {
                // The error text is sanitized too, not just the label: the copy
                // strategies build their messages as `... failed: {src} -> {dest}:
                // {io_error}`, which re-embeds the very filename the label took
                // care to neutralize. Sanitizing only the label would leave the
                // escape sequence a few characters further along the same line.
                let msg = sanitize_for_display(&e.to_string());
                tracker.fail_task(task_ids[i], &msg);
                warn_log(
                    io,
                    &format!(
                        "Warning: Failed to copy {}: {msg}",
                        sanitize_for_display(file)
                    ),
                );
            }
        }
    }
}

/// Copy directories matching `patterns` with a concurrency limit.
///
/// Returns the FIRST per-directory error (aggregated like `Promise.all`), or
/// `Ok(())`. (Unlike `copy_files`, the TS `copyDirectories` lets a per-dir error
/// reject the batch — here we surface it so the caller can react.)
///
/// `symlinked` are the `[copy] symlink` entries; see [`copy_files`] for why the
/// exclusion has to happen after expansion.
#[allow(clippy::too_many_arguments)]
pub fn copy_directories<E, T>(
    io: &impl Io,
    executor: &E,
    tracker: &T,
    patterns: &[String],
    symlinked: &SymlinkedPaths,
    repo_root: &str,
    worktree_path: &str,
    dry_run: bool,
    concurrency: usize,
) -> Result<(), String>
where
    E: CopyExecutor + Sync,
    T: ProgressTracker + Sync,
{
    let dirs = without_symlinked(
        symlinked,
        &expand_directory_patterns(io, patterns, repo_root),
    );
    if dirs.is_empty() {
        return Ok(());
    }

    if dry_run {
        log_dry_run(io, "Would copy directories:");
        for dir in &dirs {
            log_dry_run(io, &format!("  - {}", sanitize_for_display(dir)));
        }
        return Ok(());
    }

    if io.env("VIBE_DEBUG").is_some() {
        warn_log(
            io,
            &format!("[vibe] Copy strategy: {}", executor.directory_strategy()),
        );
    }
    let phase = tracker.add_phase(&format!(
        "Copying directories ({})",
        executor.directory_strategy()
    ));
    let task_ids: Vec<_> = dirs
        .iter()
        .map(|d| tracker.add_task(phase, &sanitize_for_display(d)))
        .collect();

    // Shared job queue of (index, dir). Workers pull until empty. Per-dir
    // failures are recorded here (NOT logged in-thread) because the injected
    // `Io` (e.g. FakeIo) is not `Sync`; we emit the warnings on the main thread
    // after the scope joins.
    let queue: Mutex<VecDeque<(usize, String)>> =
        Mutex::new(dirs.iter().cloned().enumerate().collect());
    let failures: Mutex<Vec<(usize, String, String)>> = Mutex::new(Vec::new());

    let workers = concurrency.clamp(1, dirs.len());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let job = {
                    let mut q = queue.lock().expect("copy queue mutex poisoned");
                    q.pop_front()
                };
                let Some((i, dir)) = job else { break };

                let src = join(repo_root, &dir);
                let dest = join(worktree_path, &dir);
                tracker.start_task(task_ids[i]);
                match executor.copy_directory(&src, &dest) {
                    Ok(()) => tracker.complete_task(task_ids[i]),
                    Err(e) => {
                        // Sanitized for the same reason as in `copy_resolved_files`:
                        // the message embeds `src`/`dest`, i.e. a repo-derived name.
                        let msg = sanitize_for_display(&e.to_string());
                        tracker.fail_task(task_ids[i], &msg);
                        failures
                            .lock()
                            .expect("failures mutex poisoned")
                            .push((i, dir, msg));
                    }
                }
            });
        }
    });

    // Emit warnings in stable index order, and aggregate the first error (the
    // lowest-index failure) so the result is deterministic regardless of which
    // worker thread hit it first — matching `Promise.all`'s first-rejection.
    let mut failures = failures.into_inner().expect("failures mutex poisoned");
    failures.sort_by_key(|(i, _, _)| *i);
    for (_, dir, msg) in &failures {
        warn_log(
            io,
            &format!(
                "Warning: Failed to copy directory {}: {msg}",
                sanitize_for_display(dir)
            ),
        );
    }
    match failures.first() {
        Some((_, _, msg)) => Err(msg.clone()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CopyConfig;
    use crate::copy::strategies::FakeCopyExecutor;
    use crate::copy::types::{CopyError, CopyStrategyKind};
    use crate::io::FakeIo;
    use crate::progress::{NodeId, NullTracker};
    use vibe_test_support::{fake_root, Fixture};

    fn pats(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn config_with_concurrency(n: i64) -> VibeConfig {
        VibeConfig {
            copy: Some(CopyConfig {
                concurrency: Some(n),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    // --- resolve_copy_concurrency precedence ---

    #[test]
    fn env_overrides_config() {
        let io = FakeIo::new().with_env("VIBE_COPY_CONCURRENCY", "16");
        assert_eq!(
            resolve_copy_concurrency(&io, Some(&config_with_concurrency(8))),
            16
        );
    }

    #[test]
    fn invalid_env_warns_and_uses_default_not_config() {
        let io = FakeIo::new().with_env("VIBE_COPY_CONCURRENCY", "999");
        // Invalid env → DEFAULT (4), NOT the config value (8).
        assert_eq!(
            resolve_copy_concurrency(&io, Some(&config_with_concurrency(8))),
            4
        );
        assert!(io.stderr_text().contains("Invalid VIBE_COPY_CONCURRENCY"));
    }

    #[test]
    fn config_used_when_no_env() {
        let io = FakeIo::new();
        assert_eq!(
            resolve_copy_concurrency(&io, Some(&config_with_concurrency(7))),
            7
        );
    }

    #[test]
    fn default_when_nothing_set() {
        let io = FakeIo::new();
        assert_eq!(resolve_copy_concurrency(&io, None), 4);
    }

    // --- copy_files behavior ---

    #[test]
    fn copy_files_records_each_src_dest() {
        let fx = Fixture::new();
        fx.write(".env", "a");
        fx.write("config.toml", "b");
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Standard);
        let tracker = NullTracker;
        let worktree = fake_root("wt");
        copy_files(
            &io,
            &exec,
            &tracker,
            &pats(&[".env", "config.toml"]),
            &SymlinkedPaths::none(),
            fx.path().to_str().unwrap(),
            worktree.to_str().unwrap(),
            false,
        );
        let copies = exec.file_copies.lock().unwrap();
        assert_eq!(copies.len(), 2);
        assert!(copies[0].0.ends_with(".env"));
        // Built the same way the product builds it, so the assertion states the
        // destination rather than a separator convention.
        assert_eq!(copies[0].1, worktree.join(".env").to_string_lossy());
    }

    #[test]
    fn copy_files_per_file_error_does_not_abort() {
        let fx = Fixture::new();
        fx.write("good.txt", "a");
        fx.write("bad.txt", "b");
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Standard)
            .fail_on("bad.txt", CopyError::Failed("disk full".into()));
        let tracker = NullTracker;
        copy_files(
            &io,
            &exec,
            &tracker,
            &pats(&["good.txt", "bad.txt"]),
            &SymlinkedPaths::none(),
            fx.path().to_str().unwrap(),
            "/wt",
            false,
        );
        // Both were attempted; the failure was warned, not propagated.
        assert_eq!(exec.file_copies.lock().unwrap().len(), 2);
        assert!(io.stderr_text().contains("Failed to copy bad.txt"));
    }

    #[test]
    fn copy_files_dry_run_logs_and_skips() {
        let fx = Fixture::new();
        fx.write(".env", "a");
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Standard);
        let tracker = NullTracker;
        copy_files(
            &io,
            &exec,
            &tracker,
            &pats(&[".env"]),
            &SymlinkedPaths::none(),
            fx.path().to_str().unwrap(),
            "/wt",
            true,
        );
        assert!(exec.file_copies.lock().unwrap().is_empty());
        assert!(io.stderr_text().contains("[dry-run] Would copy files:"));
        assert!(io.stderr_text().contains("  - .env"));
    }

    // --- `[copy] symlink` exclusion happens AFTER glob expansion ---

    /// `dirs = [".*"]` does not compare equal to `symlink = [".cache"]`, but it
    /// EXPANDS to it. Copying it would run the strategy into the destination
    /// that was just symlinked at the origin's `.cache`, writing through the
    /// link and corrupting the shared directory.
    #[test]
    fn copy_directories_drops_a_glob_match_that_is_symlinked() {
        let fx = Fixture::new();
        fx.mkdir(".cache");
        fx.mkdir(".turbo");
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Clone);
        let res = copy_directories(
            &io,
            &exec,
            &NullTracker,
            &pats(&[".*"]),
            &SymlinkedPaths::from_patterns(&pats(&[".cache"]), false),
            fx.path().to_str().unwrap(),
            "/wt",
            false,
            4,
        );
        assert!(res.is_ok());
        let copied: Vec<String> = exec
            .dir_copies
            .lock()
            .unwrap()
            .iter()
            .map(|(src, _)| src.clone())
            .collect();
        assert!(
            copied.iter().all(|s| !s.ends_with(".cache")),
            "the symlinked directory must not be copied: {copied:?}"
        );
        assert!(
            copied.iter().any(|s| s.ends_with(".turbo")),
            "the other glob matches must still be copied: {copied:?}"
        );
    }

    /// The same hole on the file side: a file UNDER a shared directory would be
    /// copied through the link into the origin worktree.
    #[test]
    fn copy_files_drops_a_glob_match_under_a_symlinked_directory() {
        let fx = Fixture::new();
        fx.write(".cache/secret.json", "shared");
        fx.write("keep.json", "mine");
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Standard);
        copy_files(
            &io,
            &exec,
            &NullTracker,
            &pats(&["**/*.json"]),
            &SymlinkedPaths::from_patterns(&pats(&[".cache"]), false),
            fx.path().to_str().unwrap(),
            "/wt",
            false,
        );
        let copied: Vec<String> = exec
            .file_copies
            .lock()
            .unwrap()
            .iter()
            .map(|(src, _)| src.clone())
            .collect();
        assert!(
            copied.iter().all(|s| !s.contains(".cache")),
            "must not copy through the shared link: {copied:?}"
        );
        assert!(
            copied.iter().any(|s| s.ends_with("keep.json")),
            "unrelated matches must survive: {copied:?}"
        );
    }

    /// On a case-insensitive volume (APFS, NTFS) `dirs = [".cache"]` names the
    /// SAME directory entry as `symlink = [".Cache"]`, so the copy would land on
    /// the link and write through it into the origin. The exclusion must fold
    /// case exactly when the destination filesystem does.
    #[test]
    fn case_variant_spelling_is_excluded_on_a_case_insensitive_volume() {
        let fx = Fixture::new();
        fx.mkdir(".cache");
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Clone);
        let res = copy_directories(
            &io,
            &exec,
            &NullTracker,
            &pats(&[".cache"]),
            &SymlinkedPaths::from_patterns(&pats(&[".Cache"]), true),
            fx.path().to_str().unwrap(),
            "/wt",
            false,
            4,
        );
        assert!(res.is_ok());
        assert!(
            exec.dir_copies.lock().unwrap().is_empty(),
            "a case-variant spelling must not be copied through the link"
        );
    }

    /// The same pair on a case-SENSITIVE volume names two different directories,
    /// so the copy must still run — the fold is driven by the filesystem, not by
    /// a blanket rule that would silently drop legitimate copies on Linux.
    #[test]
    fn case_variant_spelling_is_copied_on_a_case_sensitive_volume() {
        let fx = Fixture::new();
        fx.mkdir(".cache");
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Clone);
        let res = copy_directories(
            &io,
            &exec,
            &NullTracker,
            &pats(&[".cache"]),
            &SymlinkedPaths::from_patterns(&pats(&[".Cache"]), false),
            fx.path().to_str().unwrap(),
            "/wt",
            false,
            4,
        );
        assert!(res.is_ok());
        assert_eq!(exec.dir_copies.lock().unwrap().len(), 1);
    }

    /// The git-derived candidates (`[copy] untracked` / `modified`) reach the
    /// runner as literal paths that never went through the glob expander, so the
    /// exclusion has to live in `copy_resolved_files` to see them at all. A file
    /// `git status` reports under a shared directory is already visible through
    /// the link; copying it would write through the link into the origin repo.
    #[test]
    fn resolved_git_derived_paths_under_a_symlinked_directory_are_dropped() {
        let fx = Fixture::new();
        fx.write(".cache/untracked.bin", "shared");
        fx.write("notes.txt", "mine");
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Standard);
        copy_resolved_files(
            &io,
            &exec,
            &NullTracker,
            &[".cache/untracked.bin".to_string(), "notes.txt".to_string()],
            &SymlinkedPaths::from_patterns(&pats(&[".cache"]), false),
            fx.path().to_str().unwrap(),
            "/wt",
            false,
        );
        let copied: Vec<String> = exec
            .file_copies
            .lock()
            .unwrap()
            .iter()
            .map(|(src, _)| src.clone())
            .collect();
        assert!(
            copied.iter().all(|s| !s.contains(".cache")),
            "a git-derived path under a created symlink must not be copied: {copied:?}"
        );
        assert!(
            copied.iter().any(|s| s.ends_with("notes.txt")),
            "unrelated git-derived paths must still be copied: {copied:?}"
        );
    }

    #[test]
    fn dry_run_neutralizes_control_characters_in_git_derived_names() {
        // `[copy] untracked` feeds real filenames straight into this list, so a
        // name carrying an ESC sequence or a bidi override must not reach the
        // terminal intact: it could clear the line or visually reverse the path.
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Standard);
        let tracker = NullTracker;
        let nasty = "evil\u{1b}[2K\u{202e}gnp.exe";
        copy_resolved_files(
            &io,
            &exec,
            &tracker,
            &[nasty.to_string()],
            &SymlinkedPaths::none(),
            "/repo",
            "/wt",
            true,
        );
        let out = io.stderr_text();
        assert!(
            !out.contains('\u{1b}') && !out.contains('\u{202e}'),
            "control characters reached the terminal: {out:?}"
        );
        assert!(out.contains("evil\u{fffd}[2K\u{fffd}gnp.exe"), "{out:?}");
    }

    #[test]
    fn copy_failure_warning_neutralizes_control_characters() {
        // No fixture: the fake executor never touches the filesystem, and a name
        // carrying an ESC byte cannot even be created on Windows (NTFS).
        let nasty = "bad\u{1b}[2Kname.txt";
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Standard)
            .fail_on(nasty, CopyError::Failed("disk full".into()));
        let tracker = NullTracker;
        copy_resolved_files(
            &io,
            &exec,
            &tracker,
            &[nasty.to_string()],
            &SymlinkedPaths::none(),
            "/repo",
            "/wt",
            false,
        );
        let out = io.stderr_text();
        assert!(
            out.contains("Failed to copy bad\u{fffd}[2Kname.txt"),
            "{out:?}"
        );
        assert!(!out.contains('\u{1b}'), "{out:?}");
        // The copy itself still used the real, unsanitized name.
        let copies = exec.file_copies.lock().unwrap();
        assert!(copies[0].0.contains(nasty), "{:?}", copies[0].0);
    }

    #[test]
    fn copy_failure_neutralizes_control_characters_inside_the_error_text() {
        // The real strategies phrase failures as `... failed: {src} -> {dest}: {e}`,
        // so the attacker-controlled filename appears a SECOND time inside the
        // error message. Sanitizing only the label would still let an ESC reach the
        // terminal, a few characters further along the same warning line.
        // No fixture, for the same Windows reason as the warning test above.
        let nasty = "bad\u{1b}[2Kname.txt";
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Standard).fail_on(
            nasty,
            CopyError::Failed(format!(
                "Standard copy failed: /repo/{nasty} -> /wt/{nasty}: No space left on device"
            )),
        );
        let tracker = RecordingTracker::default();
        copy_resolved_files(
            &io,
            &exec,
            &tracker,
            &[nasty.to_string()],
            &SymlinkedPaths::none(),
            "/repo",
            "/wt",
            false,
        );
        let out = io.stderr_text();
        assert!(
            !out.contains('\u{1b}'),
            "the error text leaked a control character: {out:?}"
        );
        // The message is still there and still names the file, just neutralized.
        assert!(
            out.contains("Standard copy failed: /repo/bad\u{fffd}[2Kname.txt"),
            "{out:?}"
        );
        // The same text is handed to the progress tracker, which renders it to the
        // terminal on its own, so it must be neutralized there too.
        let failures = tracker.failures.lock().unwrap();
        assert_eq!(failures.len(), 1);
        assert!(
            !failures[0].contains('\u{1b}'),
            "fail_task received an unsanitized message: {:?}",
            failures[0]
        );
    }

    /// A tracker that captures the message passed to `fail_task`, so a test can
    /// assert on what the live renderer would draw.
    #[derive(Default)]
    struct RecordingTracker {
        failures: Mutex<Vec<String>>,
    }

    impl ProgressTracker for RecordingTracker {
        fn add_phase(&self, _label: &str) -> NodeId {
            NodeId(0)
        }
        fn add_task(&self, _parent: NodeId, _label: &str) -> NodeId {
            NodeId(0)
        }
        fn start_task(&self, _id: NodeId) {}
        fn complete_task(&self, _id: NodeId) {}
        fn fail_task(&self, _id: NodeId, err: &str) {
            self.failures
                .lock()
                .expect("failures mutex poisoned")
                .push(err.to_string());
        }
        fn skip_task(&self, _id: NodeId) {}
        fn start(&self) {}
        fn finish(&self) {}
    }

    // --- copy_directories concurrency + error aggregation ---

    #[test]
    fn copy_directories_copies_all_dirs() {
        let fx = Fixture::new();
        fx.mkdir("node_modules");
        fx.mkdir(".cache");
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Clone);
        let tracker = NullTracker;
        let res = copy_directories(
            &io,
            &exec,
            &tracker,
            &pats(&["node_modules", ".cache"]),
            &SymlinkedPaths::none(),
            fx.path().to_str().unwrap(),
            "/wt",
            false,
            4,
        );
        assert!(res.is_ok());
        assert_eq!(exec.dir_copies.lock().unwrap().len(), 2);
    }

    #[test]
    fn copy_directories_aggregates_first_error() {
        let fx = Fixture::new();
        fx.mkdir("ok_dir");
        fx.mkdir("bad_dir");
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Clone)
            .fail_on("bad_dir", CopyError::Failed("boom".into()));
        let tracker = NullTracker;
        let res = copy_directories(
            &io,
            &exec,
            &tracker,
            &pats(&["ok_dir", "bad_dir"]),
            &SymlinkedPaths::none(),
            fx.path().to_str().unwrap(),
            "/wt",
            // concurrency 1 makes ordering deterministic for the assertion.
            false,
            1,
        );
        assert_eq!(res, Err("boom".to_string()));
        assert!(io
            .stderr_text()
            .contains("Failed to copy directory bad_dir"));
    }

    // --- G-14: concurrency limit is honored ---

    #[test]
    fn copy_directories_honors_concurrency_limit() {
        use std::sync::atomic::Ordering;
        let fx = Fixture::new();
        // Eight directories so a too-loose limit would clearly exceed the cap.
        let names: Vec<String> = (0..8).map(|i| format!("dir{i}")).collect();
        for n in &names {
            fx.mkdir(n);
        }
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Clone).observing_concurrency();
        let tracker = NullTracker;
        let limit = 2;
        let res = copy_directories(
            &io,
            &exec,
            &tracker,
            &names,
            &SymlinkedPaths::none(),
            fx.path().to_str().unwrap(),
            "/wt",
            false,
            limit,
        );
        assert!(res.is_ok());
        assert_eq!(exec.dir_copies.lock().unwrap().len(), 8);
        // No more than `limit` directory copies ran simultaneously.
        let peak = exec.max_in_flight.load(Ordering::SeqCst);
        assert!(
            peak <= limit,
            "concurrency limit {limit} exceeded: peak in-flight was {peak}"
        );
        // And the limit was actually reached (proves it ran in parallel, not serial).
        assert!(
            peak >= 2,
            "expected parallelism up to the limit; peak was {peak}"
        );
    }

    #[test]
    fn copy_directories_dry_run_logs_and_skips() {
        let fx = Fixture::new();
        fx.mkdir("node_modules");
        let io = FakeIo::new();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Standard);
        let tracker = NullTracker;
        let res = copy_directories(
            &io,
            &exec,
            &tracker,
            &pats(&["node_modules"]),
            &SymlinkedPaths::none(),
            fx.path().to_str().unwrap(),
            "/wt",
            true,
            4,
        );
        assert!(res.is_ok());
        assert!(exec.dir_copies.lock().unwrap().is_empty());
        assert!(io
            .stderr_text()
            .contains("[dry-run] Would copy directories:"));
    }
}
