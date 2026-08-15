//! Tests for `list_command`, its pure helpers, and the `--json` schema.
//!
//! Split out of `list.rs` (as `start.rs`/`clean.rs` already do) because the
//! suite is larger than the module it covers.

use super::*;
use crate::io::FakeIo;
use std::cell::RefCell;

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
    /// Message the status call fails with, so a test can inject hostile bytes.
    status_error: Option<String>,
    /// Whether the batched `for-each-ref` call itself must fail.
    failing_ref_lookup: bool,
    /// Answer for `git log -1` on a detached worktree, as `(unix, iso)`.
    detached_log: Option<(i64, String)>,
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
            status_error: None,
            failing_ref_lookup: false,
            detached_log: None,
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

    /// Fail `path`'s status call with a specific message.
    fn with_status_error(mut self, path: &str, message: &str) -> Self {
        self.failing_status.push(path.to_string());
        self.status_error = Some(message.to_string());
        self
    }

    /// Make the batched `for-each-ref` call fail outright.
    fn with_failing_ref_lookup(mut self) -> Self {
        self.failing_ref_lookup = true;
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
            if self.failing_ref_lookup {
                return Err(VibeError::GitOperation {
                    command: args.join(" "),
                    message: "failed: fatal: bad object".to_string(),
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
                // The FULL refname, as the `%(refname)` format asks for: the
                // production parser strips `refs/heads/` itself, so a fake
                // emitting short names would exercise a shape git never sends.
                out.push_str(&format!(
                    "refs/heads/{branch}\0{unix}\0{iso}\0{}\n",
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
                    message: self
                        .status_error
                        .clone()
                        .unwrap_or_else(|| "failed: fatal: not a git repository".to_string()),
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

fn run(io: &FakeIo, git: &ListGit, cwd: &str, json: bool) -> Result<Outcome> {
    let deps = ListDeps {
        io,
        git,
        cwd,
        now_ms: NOW_MS,
    };
    list_command(&deps, json, OutputOptions::default())
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
    let deps = ListDeps {
        io: &io,
        git: &git,
        cwd: "/repo/main",
        now_ms: NOW_MS,
    };
    list_command(&deps, false, OutputOptions::new(false, true)).unwrap();
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
    let deps = ListDeps {
        io: &io,
        git: &git,
        cwd: "/repo/main",
        now_ms: NOW_MS,
    };
    list_command(&deps, true, OutputOptions::new(true, false)).unwrap();

    let text = io.stderr_text();
    assert!(!text.contains("[verbose]"), "diagnostic leaked: {text}");
    // The whole stream parses as JSON, byte for byte.
    serde_json::from_str::<serde_json::Value>(&text).expect("stderr must be pure JSON");
}

#[test]
fn verbose_still_reports_the_count_in_text_mode() {
    let io = no_home();
    let git = ListGit::with(&[("/repo/main", "main")]);
    let deps = ListDeps {
        io: &io,
        git: &git,
        cwd: "/repo/main",
        now_ms: NOW_MS,
    };
    list_command(&deps, false, OutputOptions::new(true, false)).unwrap();
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
            || arg.starts_with("--format=%(refname)")
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

#[test]
fn a_failed_ref_lookup_leaves_base_unknown_instead_of_guessing() {
    // What it guarantees: when the batched `for-each-ref` call itself fails,
    // nothing is known about ANY branch's upstream, so BASE degrades to `-`
    // rather than falling back to the default branch.
    //
    // The fallback is only correct when the call ANSWERED and the branch simply
    // tracks nothing. Applying it to a call that never answered would make
    // `list` assert "based on develop" about every row on no evidence — a
    // stated fact that is wrong, which is worse than an admitted unknown.
    let io = no_home();
    let git = ListGit::with(&[("/repo/feat", "feat/x")])
        .with_ref("feat/x", 60, Some("origin/develop"))
        .with_default_branch("develop")
        .with_failing_ref_lookup();
    run(&io, &git, "/repo/feat", true).unwrap();

    let parsed: serde_json::Value = serde_json::from_str(&io.stderr_text()).unwrap();
    assert_eq!(parsed[0]["base"], serde_json::Value::Null);
    // The AGE degrades with it, for the same reason.
    assert_eq!(parsed[0]["last_commit_at"], serde_json::Value::Null);
}

#[test]
fn a_branch_missing_from_a_successful_lookup_still_falls_back() {
    // The complement of the test above: here the call ANSWERED and simply had
    // no row for this branch (an unborn branch, or one whose ref vanished), so
    // "tracks nothing" is a real observation and the default-branch fallback is
    // the documented behaviour.
    let io = no_home();
    let git = ListGit::with(&[("/repo/feat", "feat/unborn")]).with_default_branch("develop");
    run(&io, &git, "/repo/feat", true).unwrap();

    let parsed: serde_json::Value = serde_json::from_str(&io.stderr_text()).unwrap();
    assert_eq!(parsed[0]["base"], serde_json::json!("develop"));
    assert_eq!(parsed[0]["last_commit_at"], serde_json::Value::Null);
}

#[test]
fn a_status_failure_warning_is_sanitized_in_full() {
    // What it guarantees: no terminal control character reaches stderr through
    // the warning, including via git's own error text.
    //
    // git quotes the offending path back in its diagnostic, so sanitizing only
    // the path this code interpolates would still let the identical escape
    // through in git's copy of it — the message has to be sanitized as a whole.
    let io = no_home();
    let git = ListGit::with(&[("/repo/x", "feat/x")])
        .with_ref("feat/x", 60, None)
        .with_status_error(
            "/repo/x",
            "failed: fatal: cannot open '/repo/\x1b[2Kspoofed': No such file",
        );
    run(&io, &git, "/repo/x", false).unwrap();

    let text = io.stderr_text();
    assert!(
        text.contains("Could not read status"),
        "the warning must still be reported: {text}"
    );
    assert!(
        !text.contains('\x1b'),
        "an escape from git's error text reached the terminal: {text:?}"
    );
    assert!(text.contains('\u{fffd}'));
}
