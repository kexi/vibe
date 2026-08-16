//! Tests for the `[summary]` orchestrator: caching, the batch payload, the
//! bounds on the command's output, and the degradation paths.

use super::*;
use crate::io::FakeIo;
use vibe_test_support::Fixture;

fn target(name: &str, path: &str, key: &str) -> SummaryTarget {
    SummaryTarget {
        name: name.to_string(),
        path: path.to_string(),
        base: Some("develop".to_string()),
        head: Some("abc123".to_string()),
        key: key.to_string(),
        cacheable: true,
    }
}

/// A worktree whose `git status` could not be read, so its key is not a
/// trustworthy description of its state.
fn uncacheable_target(name: &str, path: &str, key: &str) -> SummaryTarget {
    SummaryTarget {
        cacheable: false,
        ..target(name, path, key)
    }
}

/// The cache itself, for the assertions that do not care whether the file
/// was writable (see [`LoadedCache`]).
fn loaded(io: &FakeIo, repo: &str, hash: &str) -> SummaryCache {
    load_cache(io, repo, hash).cache
}

fn io_for(fx: &Fixture) -> FakeIo {
    FakeIo::new().with_env("HOME", fx.path().to_str().unwrap())
}

fn request<'a>(targets: &'a [SummaryTarget]) -> SummaryRequest<'a> {
    SummaryRequest {
        command: "./summary.sh",
        main_worktree_path: "/repo",
        timeout: Duration::from_secs(30),
        targets,
    }
}

fn resolve<R: SummaryRunner>(io: &FakeIo, runner: &R, targets: &[SummaryTarget]) -> SummaryResult {
    resolve_summaries(io, runner, &request(targets), OutputOptions::default())
}

// --- the happy path and caching -----------------------------------------

#[test]
fn asks_the_command_and_returns_a_summary_per_worktree() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"the trunk","feat/a":"a feature"}"#);
    let targets = vec![
        target("main", "/repo/main", "h1:s1"),
        target("feat/a", "/repo/a", "h2:s2"),
    ];

    let result = resolve(&io, &runner, &targets);
    assert_eq!(result.by_path.get("/repo/main").unwrap(), "the trunk");
    assert_eq!(result.by_path.get("/repo/a").unwrap(), "a feature");
    assert!(result.warnings.is_empty());
    assert_eq!(runner.calls().len(), 1, "the batch is one invocation");
}

/// What it guarantees: a second run over an unchanged repository does not spawn
/// the command at all. The cache's entire purpose is only observable as the
/// ABSENCE of a call.
#[test]
fn a_full_cache_hit_never_runs_the_command() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let targets = vec![target("main", "/repo/main", "h1:s1")];

    let first = FakeSummaryRunner::with_stdout(r#"{"main":"cached value"}"#);
    resolve(&io, &first, &targets);
    assert_eq!(first.calls().len(), 1);

    let second = FakeSummaryRunner::with_stdout(r#"{"main":"should never be asked"}"#);
    let result = resolve(&io, &second, &targets);
    assert_eq!(second.calls().len(), 0, "the command must not be spawned");
    assert_eq!(result.by_path.get("/repo/main").unwrap(), "cached value");
}

/// What it guarantees: only the worktrees whose state actually changed are put
/// in front of the (possibly expensive) command.
#[test]
fn a_partial_hit_asks_only_about_the_misses() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let first = FakeSummaryRunner::with_stdout(r#"{"main":"trunk","feat/a":"old a"}"#);
    resolve(
        &io,
        &first,
        &[
            target("main", "/repo/main", "h1:s1"),
            target("feat/a", "/repo/a", "h2:s2"),
        ],
    );

    // feat/a got a new commit: its key changes, main's does not.
    let second = FakeSummaryRunner::with_stdout(r#"{"feat/a":"new a"}"#);
    let result = resolve(
        &io,
        &second,
        &[
            target("main", "/repo/main", "h1:s1"),
            target("feat/a", "/repo/a", "h9:s9"),
        ],
    );

    let payload: serde_json::Value =
        serde_json::from_str(&second.calls()[0].stdin_payload).unwrap();
    let names: Vec<&str> = payload["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["feat/a"], "only the changed worktree was asked");

    // The cached row is still answered, from disk.
    assert_eq!(result.by_path.get("/repo/main").unwrap(), "trunk");
    assert_eq!(result.by_path.get("/repo/a").unwrap(), "new a");
}

#[test]
fn the_stdin_payload_matches_the_documented_contract() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::with_stdout("{}");
    let mut t = target("feat/a", "/repo/a", "k");
    t.base = None;
    t.head = None;
    resolve(&io, &runner, &[t]);

    let payload: serde_json::Value =
        serde_json::from_str(&runner.calls()[0].stdin_payload).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({
            "worktrees": [
                // Unknown base/head are explicit nulls, never omitted keys, so a
                // consumer can read `.base` unconditionally.
                { "name": "feat/a", "path": "/repo/a", "base": null, "head": null }
            ]
        })
    );
}

#[test]
fn the_command_runs_in_the_main_worktree_with_the_configured_timeout() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::with_stdout("{}");
    let targets = vec![target("main", "/repo/main", "k")];
    resolve_summaries(
        &io,
        &runner,
        &SummaryRequest {
            command: "./s.sh",
            main_worktree_path: "/repo",
            timeout: Duration::from_secs(7),
            targets: &targets,
        },
        OutputOptions::default(),
    );

    let call = &runner.calls()[0];
    assert_eq!(call.cwd, "/repo");
    assert_eq!(call.command, "./s.sh");
    assert_eq!(call.timeout, Duration::from_secs(7));
}

/// What it guarantees: editing the command invalidates every stored summary, so
/// the column can never show an answer the current command never produced.
#[test]
fn changing_the_command_re_asks_for_everything() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let targets = vec![target("main", "/repo/main", "k")];

    let first = FakeSummaryRunner::with_stdout(r#"{"main":"from v1"}"#);
    resolve_summaries(&io, &first, &request(&targets), OutputOptions::default());

    let second = FakeSummaryRunner::with_stdout(r#"{"main":"from v2"}"#);
    let result = resolve_summaries(
        &io,
        &second,
        &SummaryRequest {
            command: "./different.sh",
            main_worktree_path: "/repo",
            timeout: Duration::from_secs(30),
            targets: &targets,
        },
        OutputOptions::default(),
    );
    assert_eq!(
        second.calls().len(),
        1,
        "the cache must have been discarded"
    );
    assert_eq!(result.by_path.get("/repo/main").unwrap(), "from v2");
}

/// What it guarantees: the cache file cannot grow once per worktree ever
/// created — a `start`/`clean` cycle must not leave a permanent record.
#[test]
fn entries_for_worktrees_that_are_gone_are_pruned_on_write() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"m","feat/a":"a"}"#);
    resolve(
        &io,
        &runner,
        &[
            target("main", "/repo/main", "k"),
            target("feat/a", "/repo/a", "k"),
        ],
    );

    // feat/a has been cleaned away; a new run sees only main.
    let runner2 = FakeSummaryRunner::with_stdout("{}");
    resolve(&io, &runner2, &[target("main", "/repo/main", "k")]);

    let cache = loaded(&io, "/repo", &command_hash("./summary.sh"));
    assert_eq!(cache.entries.len(), 1);
    assert!(cache.entries.contains_key("/repo/main"));
}

/// What it guarantees: a corrupt cache costs a regeneration, never the listing.
#[test]
fn a_corrupt_cache_degrades_to_asking_the_command() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    // Plant garbage where the cache file for /repo lives.
    let dir = crate::config_path::ensure_cache_subdir(&io, "summaries").unwrap();
    let name = format!("{}.json", crate::hash::hash_content(b"/repo"));
    std::fs::write(dir.join(name), "{ truncated").unwrap();

    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"regenerated"}"#);
    let result = resolve(&io, &runner, &[target("main", "/repo/main", "k")]);
    assert_eq!(runner.calls().len(), 1);
    assert_eq!(result.by_path.get("/repo/main").unwrap(), "regenerated");
}

// --- failure and fallback -------------------------------------------------

/// What it guarantees: a timeout shows the previous answer rather than blanking
/// the column, and says so.
#[test]
fn a_timeout_falls_back_to_the_cached_value_with_a_warning() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let ok = FakeSummaryRunner::with_stdout(r#"{"main":"the good answer"}"#);
    resolve(&io, &ok, &[target("main", "/repo/main", "k1")]);

    // The worktree changed, so it is a miss — and now the command hangs.
    let slow = FakeSummaryRunner::timing_out();
    let result = resolve(&io, &slow, &[target("main", "/repo/main", "k2")]);

    assert_eq!(result.by_path.get("/repo/main").unwrap(), "the good answer");
    assert_eq!(result.warnings.len(), 1);
    assert!(
        result.warnings[0].contains("timed out"),
        "got: {}",
        result.warnings[0]
    );
}

#[test]
fn a_nonzero_exit_warns_and_falls_back() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let ok = FakeSummaryRunner::with_stdout(r#"{"main":"cached"}"#);
    resolve(&io, &ok, &[target("main", "/repo/main", "k1")]);

    let bad = FakeSummaryRunner::failing(3, "boom\nmore detail");
    let result = resolve(&io, &bad, &[target("main", "/repo/main", "k2")]);
    assert_eq!(result.by_path.get("/repo/main").unwrap(), "cached");
    assert!(
        result.warnings[0].contains("code 3"),
        "got: {:?}",
        result.warnings
    );
    // Only the first line of stderr is quoted, so a chatty failure cannot
    // flood the terminal.
    assert!(!result.warnings[0].contains("more detail"));
}

#[test]
fn a_command_that_cannot_be_spawned_warns_instead_of_failing() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::spawn_error("No such file or directory");
    let result = resolve(&io, &runner, &[target("main", "/repo/main", "k")]);
    assert!(result.by_path.is_empty());
    assert_eq!(result.warnings.len(), 1);
}

/// What it guarantees: a failure with nothing cached leaves the cell blank
/// rather than inventing a value.
#[test]
fn a_failure_with_no_cached_value_yields_no_summary() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::timing_out();
    let result = resolve(&io, &runner, &[target("main", "/repo/main", "k")]);
    assert!(result.by_path.is_empty());
}

#[test]
fn non_json_stdout_is_a_warning_not_a_summary() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::with_stdout("this is not JSON at all");
    let result = resolve(&io, &runner, &[target("main", "/repo/main", "k")]);
    assert!(result.by_path.is_empty());
    assert!(
        result.warnings[0].contains("valid JSON"),
        "got: {:?}",
        result.warnings
    );
}

/// What it guarantees: a name the command stayed silent about is a blank cell
/// AND is not cached, so the next run asks again.
#[test]
fn a_missing_name_produces_no_summary_and_no_cache_entry() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"m"}"#);
    let targets = vec![
        target("main", "/repo/main", "k"),
        target("feat/a", "/repo/a", "k"),
    ];
    let result = resolve(&io, &runner, &targets);
    assert!(!result.by_path.contains_key("/repo/a"));

    let cache = loaded(&io, "/repo", &command_hash("./summary.sh"));
    assert!(!cache.entries.contains_key("/repo/a"));

    // The next run asks about it again.
    let again = FakeSummaryRunner::with_stdout(r#"{"feat/a":"finally"}"#);
    let result = resolve(&io, &again, &targets);
    let payload: serde_json::Value = serde_json::from_str(&again.calls()[0].stdin_payload).unwrap();
    assert_eq!(payload["worktrees"].as_array().unwrap().len(), 1);
    assert_eq!(result.by_path.get("/repo/a").unwrap(), "finally");
}

// --- duplicate names ------------------------------------------------------

/// What it guarantees: when two worktrees share a `name`, neither is asked
/// about — an answer keyed by that name could not be attributed to one of them,
/// and a blank cell is safer than a summary shown on the wrong row.
#[test]
fn worktrees_sharing_a_name_are_excluded_from_the_request() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"m"}"#);
    let result = resolve(
        &io,
        &runner,
        &[
            target("main", "/repo/main", "k"),
            target("dup", "/repo/one", "k"),
            target("dup", "/repo/two", "k"),
        ],
    );

    let payload: serde_json::Value =
        serde_json::from_str(&runner.calls()[0].stdin_payload).unwrap();
    let names: Vec<&str> = payload["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["main"]);
    assert!(!result.by_path.contains_key("/repo/one"));
    assert!(!result.by_path.contains_key("/repo/two"));
}

#[test]
fn a_batch_of_only_duplicates_never_spawns_the_command() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::with_stdout("{}");
    resolve(
        &io,
        &runner,
        &[
            target("dup", "/repo/one", "k"),
            target("dup", "/repo/two", "k"),
        ],
    );
    assert_eq!(runner.calls().len(), 0);
}

#[test]
fn a_duplicate_name_is_reported_once_under_verbose() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::with_stdout("{}");
    resolve_summaries(
        &io,
        &runner,
        &request(&[
            target("dup", "/repo/one", "k"),
            target("dup", "/repo/two", "k"),
        ]),
        OutputOptions::new(true, false),
    );
    let lines: Vec<String> = io
        .stderr
        .borrow()
        .iter()
        .filter(|l| l.contains("Skipping summary"))
        .cloned()
        .collect();
    assert_eq!(lines.len(), 1, "one message per collision: {lines:?}");
}

// --- bounds on the command's output ---------------------------------------

/// What it guarantees: a command streaming unbounded output cannot be stored or
/// rendered — the whole answer is rejected rather than partially trusted.
#[test]
fn stdout_larger_than_the_cap_is_rejected() {
    let huge = format!(r#"{{"main":"{}"}}"#, "x".repeat(MAX_SUMMARY_STDOUT_BYTES));
    let err = parse_summary_stdout(&huge, 1).unwrap_err();
    assert!(err.contains("bytes"), "got: {err}");
}

#[test]
fn stdout_at_the_cap_is_still_parsed() {
    // One byte under the limit must be accepted, so the boundary is exact.
    let filler = MAX_SUMMARY_STDOUT_BYTES - r#"{"main":""}"#.len();
    let payload = format!(r#"{{"main":"{}"}}"#, "x".repeat(filler));
    assert_eq!(payload.len(), MAX_SUMMARY_STDOUT_BYTES);
    assert!(parse_summary_stdout(&payload, 1).is_ok());
}

/// What it guarantees: the answer's SIZE is bounded by the size of the request,
/// so an untrusted process cannot make us build an arbitrarily large map out of
/// an input that is itself under the byte cap (short keys pack in densely).
#[test]
fn an_answer_with_far_more_keys_than_worktrees_is_rejected() {
    let mut map = serde_json::Map::new();
    for i in 0..50 {
        map.insert(format!("k{i}"), serde_json::Value::String("s".into()));
    }
    let payload = serde_json::Value::Object(map).to_string();

    // Asked about two worktrees: 50 keys is far past the slack factor.
    let err = parse_summary_stdout(&payload, 2).unwrap_err();
    assert!(err.contains("50 entries"), "got: {err}");

    // Asked about enough worktrees, the same document is fine.
    assert!(parse_summary_stdout(&payload, 50).is_ok());
}

/// What it guarantees: the bound has slack, so a command that also answers for
/// worktrees it was not asked about this run is not treated as hostile.
#[test]
fn a_few_extra_keys_beyond_the_request_are_tolerated() {
    let payload = r#"{"a":"1","b":"2","c":"3","d":"4"}"#;
    // One worktree asked about, four answers: within the slack factor.
    assert!(parse_summary_stdout(payload, 1).is_ok());
    // A fifth crosses it.
    let five = r#"{"a":"1","b":"2","c":"3","d":"4","e":"5"}"#;
    assert!(parse_summary_stdout(five, 1).is_err());
}

#[test]
fn a_non_object_document_is_a_contract_violation() {
    for bad in ["[]", r#""a string""#, "42", "null"] {
        let err = parse_summary_stdout(bad, 1).unwrap_err();
        assert!(err.contains("JSON object"), "{bad} -> {err}");
    }
}

/// What it guarantees: a non-string value is refused, not coerced — coercion
/// would make a cell's rendering depend on the type the command happened to
/// emit.
#[test]
fn a_non_string_value_is_a_contract_violation() {
    for bad in [r#"{"main":42}"#, r#"{"main":["a"]}"#, r#"{"main":null}"#] {
        let err = parse_summary_stdout(bad, 1).unwrap_err();
        assert!(err.contains("must be a string"), "{bad} -> {err}");
    }
}

/// What it guarantees: a multi-line summary cannot break the table's row
/// structure — only the first line survives.
#[test]
fn a_multiline_summary_is_cut_at_the_first_line_break() {
    assert_eq!(truncate_summary("first line\nsecond line"), "first line");
    assert_eq!(truncate_summary("first\r\nsecond"), "first");
    assert_eq!(truncate_summary("only\rsecond"), "only");
    // Surrounding whitespace is trimmed so the column does not start ragged.
    assert_eq!(truncate_summary("  padded  \nrest"), "padded");
}

#[test]
fn a_very_long_summary_is_truncated_with_an_ellipsis() {
    let long = "a".repeat(MAX_SUMMARY_CHARS + 100);
    let out = truncate_summary(&long);
    assert_eq!(out.chars().count(), MAX_SUMMARY_CHARS);
    assert!(out.ends_with('…'));
}

#[test]
fn truncation_counts_characters_so_multibyte_text_stays_valid() {
    // A byte-based cut would slice a 3-byte character in half.
    let long = "日".repeat(MAX_SUMMARY_CHARS + 10);
    let out = truncate_summary(&long);
    assert_eq!(out.chars().count(), MAX_SUMMARY_CHARS);
}

#[test]
fn a_summary_at_the_length_limit_is_kept_verbatim() {
    let exact = "a".repeat(MAX_SUMMARY_CHARS);
    assert_eq!(truncate_summary(&exact), exact);
}

/// What it guarantees: the bounds are applied to what is STORED, so a hostile
/// value cannot be smuggled into the cache and replayed on later runs.
#[test]
fn the_stored_summary_is_the_truncated_one() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"line one\nline two"}"#);
    resolve(&io, &runner, &[target("main", "/repo/main", "k")]);

    let cache = loaded(&io, "/repo", &command_hash("./summary.sh"));
    assert_eq!(cache.get("/repo/main", "k"), Some("line one"));
}

// --- an unreadable status opts the row out of the cache -------------------

/// What it guarantees: a worktree whose status could not be read never HITS the
/// cache, even against an entry whose key is byte-identical.
///
/// The key digests the status payload, and an absent payload digests exactly
/// like an empty (clean) one. Without the opt-out, a worktree cached while clean
/// would be served that summary on any later run where the status call happened
/// to fail — however much the working tree had changed in between.
#[test]
fn a_worktree_with_an_unreadable_status_does_not_hit_the_cache() {
    let fx = Fixture::new();
    let io = io_for(&fx);

    // Cached while clean.
    let first = FakeSummaryRunner::with_stdout(r#"{"main":"cached while clean"}"#);
    resolve(&io, &first, &[target("main", "/repo/main", "k")]);
    assert_eq!(first.calls().len(), 1);

    // Now the status call fails. The key is the SAME string, so only the
    // `cacheable` flag can prevent the hit.
    let second = FakeSummaryRunner::with_stdout(r#"{"main":"asked again"}"#);
    let result = resolve(
        &io,
        &second,
        &[uncacheable_target("main", "/repo/main", "k")],
    );

    assert_eq!(second.calls().len(), 1, "an untrustworthy key must not hit");
    assert_eq!(result.by_path.get("/repo/main").unwrap(), "asked again");
}

/// What it guarantees: nor is such a row WRITTEN, so it cannot poison a later
/// run that does manage to read the status.
#[test]
fn a_worktree_with_an_unreadable_status_is_not_stored() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"answered anyway"}"#);
    let result = resolve(
        &io,
        &runner,
        &[uncacheable_target("main", "/repo/main", "k")],
    );

    // The answer is still used for THIS run.
    assert_eq!(result.by_path.get("/repo/main").unwrap(), "answered anyway");
    // But nothing was persisted under a key that does not describe the worktree.
    let cache = loaded(&io, "/repo", &command_hash("./summary.sh"));
    assert!(
        !cache.entries.contains_key("/repo/main"),
        "an untrustworthy key must not be written: {:?}",
        cache.entries
    );
}

/// What it guarantees: the opt-out is per row — a readable neighbour in the same
/// batch still caches normally.
#[test]
fn an_unreadable_status_does_not_disable_the_cache_for_other_worktrees() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"m","feat/a":"a"}"#);
    resolve(
        &io,
        &runner,
        &[
            uncacheable_target("main", "/repo/main", "k"),
            target("feat/a", "/repo/a", "k"),
        ],
    );

    let cache = loaded(&io, "/repo", &command_hash("./summary.sh"));
    assert!(!cache.entries.contains_key("/repo/main"));
    assert_eq!(cache.get("/repo/a", "k"), Some("a"));
}

// --- pruning survives a failing command -----------------------------------

/// What it guarantees: a worktree removed since the last successful run has its
/// entry dropped even while the command is failing.
///
/// The failure path returns early to serve stale values; without an explicit
/// prune there, a misconfigured command would keep every dead worktree's entry
/// alive indefinitely — the failure is exactly the state that persists.
#[test]
fn a_failing_command_still_prunes_entries_for_deleted_worktrees() {
    let fx = Fixture::new();
    let io = io_for(&fx);

    let ok = FakeSummaryRunner::with_stdout(r#"{"main":"m","feat/a":"a"}"#);
    resolve(
        &io,
        &ok,
        &[
            target("main", "/repo/main", "k"),
            target("feat/a", "/repo/a", "k"),
        ],
    );
    assert_eq!(
        loaded(&io, "/repo", &command_hash("./summary.sh"))
            .entries
            .len(),
        2
    );

    // feat/a is gone, main has changed (so the command is consulted), and the
    // command fails.
    let failing = FakeSummaryRunner::timing_out();
    let result = resolve(&io, &failing, &[target("main", "/repo/main", "k2")]);
    assert!(!result.warnings.is_empty(), "the failure is still reported");

    let cache = loaded(&io, "/repo", &command_hash("./summary.sh"));
    assert!(
        !cache.entries.contains_key("/repo/a"),
        "the deleted worktree must be pruned even on the failure path"
    );
    // And the surviving entry is untouched, so the stale fallback keeps working.
    assert_eq!(cache.get_stale("/repo/main"), Some("m"));
}

// --- an unreadable cache file is preserved, not clobbered ------------------

/// What it guarantees: a cache file that EXISTS but cannot be read is left
/// exactly as it was.
///
/// Load degrades to an empty cache either way, so without distinguishing the
/// reason the write-back would replace intact content with `{}` — destroying
/// the stale fallback a failing command depends on, over a condition (a
/// permission blip, a transient I/O error) that may clear on the next run.
#[cfg(unix)]
#[test]
fn an_unreadable_cache_file_is_not_overwritten() {
    use std::os::unix::fs::PermissionsExt;

    let fx = Fixture::new();
    let io = io_for(&fx);

    // Populate the cache normally.
    let first = FakeSummaryRunner::with_stdout(r#"{"main":"valuable summary"}"#);
    resolve(&io, &first, &[target("main", "/repo/main", "k")]);
    let path = crate::config_path::ensure_cache_subdir(&io, "summaries")
        .unwrap()
        .join(format!("{}.json", crate::hash::hash_content(b"/repo")));
    let before = std::fs::read(&path).unwrap();
    assert!(!before.is_empty());

    // Write-only: present, but unreadable.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o200)).unwrap();

    let second = FakeSummaryRunner::with_stdout(r#"{"main":"regenerated"}"#);
    let result = resolve(&io, &second, &[target("main", "/repo/main", "k")]);
    // The run still works — it just cannot consult the cache.
    assert_eq!(second.calls().len(), 1);
    assert_eq!(result.by_path.get("/repo/main").unwrap(), "regenerated");

    // And the file is byte-identical: nothing was written over it.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        std::fs::read(&path).unwrap(),
        before,
        "an unreadable cache must survive the run untouched"
    );
    // Which means the fallback asset is still there once the condition clears.
    assert_eq!(
        loaded(&io, "/repo", &command_hash("./summary.sh")).get_stale("/repo/main"),
        Some("valuable summary")
    );
}

/// What it guarantees: the preservation is scoped to UNREADABLE files. A
/// corrupt or absent one carries no value, so it is still replaced — otherwise
/// a single bad byte would wedge the cache permanently.
#[test]
fn a_corrupt_cache_file_is_still_replaced() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let dir = crate::config_path::ensure_cache_subdir(&io, "summaries").unwrap();
    let path = dir.join(format!("{}.json", crate::hash::hash_content(b"/repo")));
    std::fs::write(&path, "{ truncated").unwrap();

    let runner = FakeSummaryRunner::with_stdout(r#"{"main":"fresh"}"#);
    resolve(&io, &runner, &[target("main", "/repo/main", "k")]);

    assert_eq!(
        loaded(&io, "/repo", &command_hash("./summary.sh")).get("/repo/main", "k"),
        Some("fresh"),
        "a worthless file must not block the write-back"
    );
}

/// What it guarantees: undecodable stdout takes the ordinary contract-violation
/// path — warn, fall back to the cached value, write nothing.
///
/// Before this, the bytes were decoded leniently and the resulting document
/// parsed, so a summary the command never produced was displayed AND cached,
/// outliving the run that invented it.
#[test]
fn invalid_utf8_stdout_is_rejected_and_falls_back_to_the_cache() {
    let fx = Fixture::new();
    let io = io_for(&fx);

    // A healthy run puts a real summary in the cache.
    let ok = FakeSummaryRunner::with_stdout(r#"{"main":"the real summary"}"#);
    resolve(&io, &ok, &[target("main", "/repo/main", "k1")]);

    // The worktree changes, and this time stdout is not valid UTF-8.
    let bad = FakeSummaryRunner::invalid_utf8_stdout();
    let result = resolve(&io, &bad, &[target("main", "/repo/main", "k2")]);

    assert_eq!(
        result.by_path.get("/repo/main").unwrap(),
        "the real summary",
        "the cached value must stand in"
    );
    assert_eq!(result.warnings.len(), 1);
    assert!(
        result.warnings[0].contains("not valid UTF-8"),
        "got: {:?}",
        result.warnings
    );

    // Nothing was written under the new key.
    let cache = loaded(&io, "/repo", &command_hash("./summary.sh"));
    assert_eq!(cache.get("/repo/main", "k2"), None);
    assert_eq!(cache.get("/repo/main", "k1"), Some("the real summary"));
}

/// What it guarantees: with nothing cached, the cell is simply blank — the
/// undecodable bytes never become a summary.
#[test]
fn invalid_utf8_stdout_yields_no_summary_when_nothing_is_cached() {
    let fx = Fixture::new();
    let io = io_for(&fx);
    let runner = FakeSummaryRunner::invalid_utf8_stdout();
    let result = resolve(&io, &runner, &[target("main", "/repo/main", "k")]);
    assert!(result.by_path.is_empty());
    assert_eq!(result.warnings.len(), 1);
}
