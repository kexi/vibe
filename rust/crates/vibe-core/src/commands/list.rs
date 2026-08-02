//! `vibe list`: show every worktree of the current repository at a glance.
//!
//! The listing IS this command's product, but it still goes to the *human*
//! channel (stderr) via the [`Io`], exactly like `vibe config`: the shell
//! wrapper evals stdout verbatim (`eval "$(command vibe "$@")"`), so a table
//! written there would be executed as shell code. `list` therefore returns
//! [`Outcome::none()`] and never emits a `cd`.
//!
//! Enumeration reuses [`get_worktree_list`] (the same source `jump` matches
//! against) and the MRU store `jump` maintains, so the two commands can never
//! disagree about which worktrees exist or which one was used last.

use crate::commands::jump::SCRATCH_PREFIX;
use crate::commands::Outcome;
use crate::error::{Result, VibeError};
use crate::git::{get_worktree_list, is_inside_worktree, lexical_normalize_path, GitRunner};
use crate::io::Io;
use crate::mru::{load_mru_data, sort_by_mru};
use crate::output::{report_log, sanitize_for_display, verbose_log, OutputOptions};
use serde::Serialize;
use unicode_width::UnicodeWidthStr;

/// Marker printed in the first column for the worktree the user is standing in.
const CURRENT_MARKER: &str = "*";

/// Label appended to a `scratch/<timestamp>` worktree so throwaway trees are
/// easy to spot (and easy to clean up).
const SCRATCH_LABEL: &str = "(scratch)";

/// Placeholder shown in the branch column for a detached-HEAD worktree, which
/// has no branch to name.
const DETACHED_LABEL: &str = "(detached)";

/// One rendered row of the listing. `Serialize` drives `--json`, so the field
/// names are the stable public schema of that output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListEntry {
    /// `None` for a detached-HEAD worktree (JSON emits `null`).
    pub branch: Option<String>,
    pub path: String,
    /// Whether this is the worktree the command was invoked from.
    pub current: bool,
    /// Whether the branch is an auto-generated `scratch/<timestamp>` worktree.
    pub scratch: bool,
}

/// Inputs `list` pulls from the binary.
pub struct ListDeps<'a, I, G>
where
    I: Io,
    G: GitRunner,
{
    pub io: &'a I,
    pub git: &'a G,
    /// The directory the command was invoked from, used to mark the current row.
    pub cwd: &'a str,
}

/// Run `vibe list [--json]`.
pub fn list_command<I, G>(deps: &ListDeps<I, G>, json: bool, opts: OutputOptions) -> Result<Outcome>
where
    I: Io,
    G: GitRunner,
{
    let inside = is_inside_worktree(deps.git);
    if !inside {
        // Same fatal (exit-1) shape `home` uses for the identical situation.
        return Err(VibeError::Worktree(
            "Not inside a git repository.".to_string(),
        ));
    }

    let entries = collect_entries(deps)?;

    if json {
        let text = serde_json::to_string_pretty(&entries).map_err(|e| {
            VibeError::Configuration(format!("Failed to serialize worktree list: {e}"))
        })?;
        // `report_log`, not `log`: the listing is the whole point of the command,
        // so `--quiet` must not turn `vibe list` into a silent no-op.
        //
        // The diagnostic is deliberately NOT emitted here: `--json` writes its
        // payload to the same stderr stream, so a `[verbose]` line would prepend
        // non-JSON bytes to the document and break `vibe --verbose list --json |
        // jq`. In JSON mode the payload is the only thing on the stream.
        report_log(deps.io, &text);
        return Ok(Outcome::none());
    }

    verbose_log(
        deps.io,
        &format!("Found {} worktree(s)", entries.len()),
        opts,
    );

    if entries.is_empty() {
        report_log(deps.io, "No worktrees found.");
        return Ok(Outcome::none());
    }

    for line in render_table(&entries) {
        report_log(deps.io, &line);
    }

    Ok(Outcome::none())
}

/// Build the ordered entry list: the current worktree first, then the rest in
/// MRU order (most recently jumped-to first), then never-visited worktrees in
/// git's own emitted order.
fn collect_entries<I, G>(deps: &ListDeps<I, G>) -> Result<Vec<ListEntry>>
where
    I: Io,
    G: GitRunner,
{
    let worktrees = get_worktree_list(deps.git)?;
    // MRU is best-effort everywhere else in the codebase; a missing or corrupt
    // store must degrade to git order, never fail the listing.
    let mru = load_mru_data(deps.io);
    let sorted = sort_by_mru(&worktrees, &mru);

    let cwd = lexical_normalize_path(deps.cwd);
    // Worktrees CAN nest (`git worktree add <wt>/inner` is accepted), so several
    // rows may contain `cwd`. The innermost one — the longest containing path —
    // is the worktree the user is actually standing in.
    let current_path = sorted
        .iter()
        .map(|w| lexical_normalize_path(&w.path))
        .filter(|base| is_within(&cwd, base))
        .max_by_key(|base| base.len());

    let mut entries: Vec<ListEntry> = sorted
        .into_iter()
        .map(|w| ListEntry {
            current: current_path.as_deref() == Some(lexical_normalize_path(&w.path).as_str()),
            scratch: w
                .branch
                .as_deref()
                .is_some_and(|b| b.starts_with(SCRATCH_PREFIX)),
            branch: w.branch,
            path: w.path,
        })
        .collect();

    // Current worktree first; the MRU order established above is preserved for
    // everything else because `sort_by_key` is stable.
    entries.sort_by_key(|e| !e.current);
    Ok(entries)
}

/// Whether `cwd` is the worktree at the already-normalized `base`, or inside it.
///
/// Comparison is lexical (like [`get_worktree_by_path`]): no filesystem access,
/// so a worktree that has just been moved out from under the process still
/// compares sanely instead of erroring.
///
/// This answers *containment* only. Containment alone does NOT identify the
/// current worktree: git permits nesting (`git worktree add <wt>/inner`
/// succeeds), so a cwd inside `inner` is contained by both rows. The caller
/// resolves that by taking the longest containing path.
///
/// [`get_worktree_by_path`]: crate::git::get_worktree_by_path
fn is_within(cwd: &str, base: &str) -> bool {
    if cwd == base {
        return true;
    }
    // Require a separator so `/repo/feature-2` is not read as inside `/repo/feature`.
    let with_sep = if base.ends_with('/') {
        base.to_string()
    } else {
        format!("{base}/")
    };
    cwd.starts_with(&with_sep)
}

/// Render the aligned plain-text table (one `String` per line).
///
/// Column width is computed from the *sanitized* branch text so a branch name
/// carrying control characters cannot skew the alignment of the other rows, and
/// in terminal *display* cells rather than codepoints: a CJK or emoji branch
/// name occupies two cells per character, so padding by `chars().count()` would
/// leave the path column ragged.
fn render_table(entries: &[ListEntry]) -> Vec<String> {
    let branches: Vec<String> = entries
        .iter()
        .map(|e| match &e.branch {
            Some(b) => sanitize_for_display(b),
            None => DETACHED_LABEL.to_string(),
        })
        .collect();
    let width = branches.iter().map(|b| b.width()).max().unwrap_or(0);

    entries
        .iter()
        .zip(&branches)
        .map(|(entry, branch)| {
            let marker = if entry.current { CURRENT_MARKER } else { " " };
            // `saturating_sub` because `width` is the max over this same set, so
            // the difference can never actually go negative.
            let pad = " ".repeat(width.saturating_sub(branch.width()));
            let path = sanitize_for_display(&entry.path);
            let mut line = format!("{marker} {branch}{pad}  {path}");
            if entry.scratch {
                line.push(' ');
                line.push_str(SCRATCH_LABEL);
            }
            line
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::FakeIo;

    /// Git returning a fixed worktree-list porcelain and reporting "inside repo".
    struct ListGit {
        porcelain: String,
        inside: bool,
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
            }
        }
    }
    impl GitRunner for ListGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            if args.contains(&"--is-inside-work-tree") {
                return Ok(if self.inside { "true" } else { "false" }.to_string());
            }
            if args.contains(&"worktree") {
                return Ok(self.porcelain.clone());
            }
            Ok(String::new())
        }
    }

    fn run(io: &FakeIo, git: &ListGit, cwd: &str, json: bool) -> Result<Outcome> {
        let deps = ListDeps { io, git, cwd };
        list_command(&deps, json, OutputOptions::default())
    }

    fn no_home() -> FakeIo {
        FakeIo::new().with_env("HOME", "/nonexistent-home")
    }

    #[test]
    fn errors_when_not_inside_a_repository() {
        let io = no_home();
        let git = ListGit {
            porcelain: String::new(),
            inside: false,
        };
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
        let git = ListGit::with(&[("/repo/main", "main"), ("/repo/s", "scratch/20260101")]);
        let outcome = run(&io, &git, "/repo/main", true).unwrap();
        assert_eq!(outcome, Outcome::none());

        // Parsed as generic JSON (not back into `ListEntry`): the assertion is
        // about the wire schema consumers depend on, not about a round-trip
        // through our own derive.
        let parsed: serde_json::Value = serde_json::from_str(&io.stderr_text()).unwrap();
        assert_eq!(
            parsed,
            serde_json::json!([
                {
                    "branch": "main",
                    "path": "/repo/main",
                    "current": true,
                    "scratch": false,
                },
                {
                    "branch": "scratch/20260101",
                    "path": "/repo/s",
                    "current": false,
                    "scratch": true,
                },
            ])
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
        let git = ListGit {
            porcelain: String::new(),
            inside: true,
        };
        run(&io, &git, "/repo", false).unwrap();
        assert!(io.stderr_text().contains("No worktrees found."));
    }

    #[test]
    fn empty_json_listing_is_an_empty_array() {
        let io = no_home();
        let git = ListGit {
            porcelain: String::new(),
            inside: true,
        };
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
        let git =
            ListGit::with_optional_branches(&[("/repo/main", Some("main")), ("/repo/det", None)]);
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
        let git =
            ListGit::with_optional_branches(&[("/repo/main", Some("main")), ("/repo/det", None)]);
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
                },
                {
                    "branch": "main",
                    "path": "/repo/main",
                    "current": false,
                    "scratch": false,
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
}
