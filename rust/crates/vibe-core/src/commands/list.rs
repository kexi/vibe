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
//!
//! # BASE
//!
//! The BASE column answers "what is this branch based on", and is resolved as
//! the branch's configured upstream with the remote prefix stripped, falling
//! back to [`get_default_branch`] when the branch tracks nothing. The main
//! worktree (the one already on the default branch) shows `-`.
//!
//! Why not a per-branch `git merge-base`: it costs one git invocation per
//! worktree on top of the status calls, and its answer is a COMMIT, not a
//! branch — mapping that commit back to a branch name is ambiguous whenever
//! several branches share the merge point (the common case right after
//! branching), so the column would sometimes name the wrong parent with no way
//! for the reader to tell. An upstream is a fact the user configured, and the
//! default branch is the documented fallback, so both are explainable.
//!
//! # SUMMARY
//!
//! The SUMMARY column exists only when the repository's `.vibe.toml` configures
//! `[summary] command`; see [`crate::summary`] for the batch protocol, the
//! cache, and the bounds applied to the command's output. Its presence follows
//! the CONFIG rather than the command's success, so an empty cell never has to
//! be read as "maybe the feature is off".
//!
//! The config is loaded from the MAIN worktree so the column does not change
//! shape depending on which checkout the user is standing in, and it goes
//! through the ordinary trust gate — an untrusted `.vibe.toml` fails the command
//! rather than silently running nothing.
//!
//! # Divergences from the original request (#408)
//!
//! The default order stays "current first, then MRU, then git order" rather
//! than the age ordering #408 proposed: `list` and `jump` are meant to present
//! the same world, and `jump`'s selection prompt is MRU-ordered. Age ordering
//! is available as an opt-in sort instead.
//!
//! # Injection surface
//!
//! Branch names reach git as *operands*, never as bare arguments that could be
//! read as flags: [`branch_ref_info`] fully qualifies each one to
//! `refs/heads/<name>`, so a branch called `--format=…` arrives as the pattern
//! `refs/heads/--format=…`. That is a structural guarantee, not a validation
//! step that a later edit could forget to apply.

use crate::commands::jump::SCRATCH_PREFIX;
use crate::commands::Outcome;
use crate::config::DEFAULT_SUMMARY_TIMEOUT_SECONDS;
use crate::config_loader::load_vibe_config;
use crate::error::{Result, VibeError};
use crate::git::{
    branch_ref_info, count_status_entries_z, detached_head_info, get_default_branch,
    get_worktree_list, is_inside_worktree, lexical_normalize_path, worktree_status_z, GitRunner,
    Worktree,
};
use crate::io::Io;
use crate::mru::{load_mru_data, sort_by_mru};
use crate::output::{report_log, sanitize_for_display, verbose_log, warn_log, OutputOptions};
use crate::settings::RepoResolver;
use crate::summary::runner::SummaryRunner;
use crate::summary::{entry_key, resolve_summaries, SummaryRequest, SummaryTarget};
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;
use unicode_width::UnicodeWidthStr;

/// Marker printed in the first column for the worktree the user is standing in.
const CURRENT_MARKER: &str = "*";

/// Label appended to a `scratch/<timestamp>` worktree so throwaway trees are
/// easy to spot (and easy to clean up).
const SCRATCH_LABEL: &str = "(scratch)";

/// Placeholder shown in the branch column for a detached-HEAD worktree, which
/// has no branch to name.
const DETACHED_LABEL: &str = "(detached)";

/// Rendered in any column whose value could not be determined.
///
/// One placeholder for every unknown rather than a per-column wording: the rows
/// are read as a table, and "unknown" is the same fact whether it is the base,
/// the age, or the status that could not be read.
const UNKNOWN_CELL: &str = "-";

/// STATUS value for a worktree with no uncommitted changes.
const STATUS_CLEAN: &str = "clean";

/// STATUS value for a worktree carrying uncommitted changes.
const STATUS_DIRTY: &str = "dirty";

/// One rendered row of the listing. `Serialize` drives `--json`, so the field
/// names are the stable public schema of that output.
///
/// New fields are appended, never inserted: `serde` serializes a struct in
/// declaration order, so reordering would change the byte output for consumers
/// that diff it. The first four fields are the v3.1.0 schema and are frozen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListEntry {
    /// `None` for a detached-HEAD worktree (JSON emits `null`).
    pub branch: Option<String>,
    pub path: String,
    /// Whether this is the worktree the command was invoked from.
    pub current: bool,
    /// Whether the branch is an auto-generated `scratch/<timestamp>` worktree.
    pub scratch: bool,
    /// A name that is always present: the branch, or for a detached HEAD the
    /// basename of the worktree directory.
    ///
    /// Why not just `branch`: a detached worktree has none, and every consumer
    /// that wants to label a row would have to re-derive the same fallback.
    pub name: String,
    /// The branch this one is based on (see the module header), or `None` for
    /// the main worktree and whenever it could not be resolved.
    pub base: Option<String>,
    /// The commit sha the worktree's HEAD points at, or `None` when the
    /// porcelain carried no `HEAD` record.
    ///
    /// `Option` rather than the empty string [`Worktree::head`] uses: every
    /// other unknown on this struct is `null` in JSON, and a consumer checking
    /// one field for `null` and another for `""` is being asked to remember an
    /// inconsistency for no reason. The empty string stays on `Worktree`, where
    /// it is the parser's "no record seen" and not a published value.
    pub head: Option<String>,
    /// The tip commit's committer date in ISO 8601, or `None` for an unborn
    /// branch (no commits yet) or an unreadable worktree.
    pub last_commit_at: Option<String>,
    /// `"clean"`, `"dirty"`, or `None` when git could not be asked.
    pub status: Option<String>,
    /// How many entries `git status` reported, or `None` when the status is
    /// unknown — kept in lockstep with `status` so a `0` never has to be read
    /// as "clean or unknown, cannot tell".
    pub dirty_files: Option<usize>,
    /// The relative age rendered in the AGE column (`3d`, `2w`, …).
    ///
    /// Not serialized: `--json` publishes `last_commit_at`, the exact timestamp,
    /// and a consumer computing its own "3 days ago" from an absolute instant is
    /// strictly better served than by our truncated approximation. Carrying it
    /// here anyway keeps the age formatted ONCE, at the point that has the epoch
    /// seconds, instead of making the renderer re-parse an ISO string.
    #[serde(skip)]
    pub age: Option<String>,
    /// The `[summary]` command's answer for this worktree.
    ///
    /// `skip_serializing_if`: a repository with no `[summary]` configured must
    /// produce exactly the JSON it produced before this field existed, so a
    /// consumer diffing the document sees no change from a feature it does not
    /// use. When `[summary]` IS configured every row carries the field, empty
    /// string included: the presence of the key then means "the feature is on",
    /// and a consumer never has to distinguish "no summary" from "no feature".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// The raw `git status -z` bytes this row's STATUS was counted from, kept
    /// only to key the summary cache.
    ///
    /// Carried on the row rather than re-fetched: the status call already
    /// happened for the STATUS column, and asking git a second time would both
    /// double the per-worktree cost and open a window where the two answers
    /// disagree.
    #[serde(skip)]
    pub status_payload: Option<Vec<u8>>,
}

/// Inputs `list` pulls from the binary.
pub struct ListDeps<'a, I, G, R, S>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: SummaryRunner,
{
    pub io: &'a I,
    pub git: &'a G,
    /// Resolves repo identity for the trust check on `.vibe.toml`.
    pub resolver: &'a R,
    /// Runs the `[summary]` command, when one is configured.
    pub summary_runner: &'a S,
    /// The directory the command was invoked from, used to mark the current row.
    pub cwd: &'a str,
    /// Current wall-clock in epoch milliseconds, for the AGE column.
    pub now_ms: i64,
    /// This build's version string, for the settings/trust store.
    pub version: &'a str,
}

/// Warnings held back until the output mode is known.
///
/// In `--json` mode the payload is the ONLY thing on stderr (the same stream the
/// diagnostics use), so a warning written as it happens would prepend non-JSON
/// bytes to the document. Collecting instead of writing makes that structural: a
/// warning added anywhere in the enrichment path cannot corrupt the payload,
/// because the only flush point knows whether text mode is in effect.
///
/// Every message is also SANITIZED on the way in. Warning text is assembled from
/// exactly the sources the table's cells are — git's error strings, worktree
/// paths, and the summary command's stderr — so a warning is as capable of
/// carrying a terminal escape as any cell, but nothing about the phrase
/// "warning" makes a caller think to escape it. Doing it here rather than at
/// each `push` site means a warning added later is safe by construction.
#[derive(Debug, Default)]
struct DeferredWarnings {
    messages: Vec<String>,
}

impl DeferredWarnings {
    fn push(&mut self, message: String) {
        // Sanitize on ENTRY, not at flush: the stored form is then the only
        // form, so any future reader of `messages` gets the safe one too.
        self.messages.push(sanitize_for_display(&message));
    }

    /// Emit everything collected. Called only on the text-mode path.
    fn flush(self, io: &impl Io) {
        for message in self.messages {
            warn_log(io, &message);
        }
    }
}

/// Run `vibe list [--json]`.
pub fn list_command<I, G, R, S>(
    deps: &ListDeps<I, G, R, S>,
    json: bool,
    opts: OutputOptions,
) -> Result<Outcome>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: SummaryRunner,
{
    let inside = is_inside_worktree(deps.git);
    if !inside {
        // Same fatal (exit-1) shape `home` uses for the identical situation.
        return Err(VibeError::Worktree(
            "Not inside a git repository.".to_string(),
        ));
    }

    let mut warnings = DeferredWarnings::default();
    let (mut entries, main_path) = collect_entries(deps, &mut warnings)?;
    // Whether the SUMMARY column exists at all. Driven by the CONFIG, not by
    // whether any summary came back: a column that appeared and disappeared with
    // the command's success would make an empty cell indistinguishable from an
    // unconfigured feature.
    let has_summary = attach_summaries(
        deps,
        &mut entries,
        main_path.as_deref(),
        &mut warnings,
        opts,
    )?;

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

    warnings.flush(deps.io);

    verbose_log(
        deps.io,
        &format!("Found {} worktree(s)", entries.len()),
        opts,
    );

    if entries.is_empty() {
        report_log(deps.io, "No worktrees found.");
        return Ok(Outcome::none());
    }

    for line in render_table(&entries, has_summary) {
        report_log(deps.io, &line);
    }

    Ok(Outcome::none())
}

/// Fill in every row's `summary`, if `[summary]` is configured. Returns whether
/// the SUMMARY column exists.
///
/// The config is read from the MAIN worktree, not from the cwd: `[summary]` is a
/// repository-wide setting, and reading it per worktree would make the column
/// appear or disappear depending on which checkout the user happens to be
/// standing in — and would let a feature branch's uncommitted `.vibe.toml`
/// silently change what runs.
///
/// An untrusted `.vibe.toml` propagates the existing [`load_vibe_config`] error
/// rather than being ignored: the whole point of the trust store is that an
/// unreviewed config never runs, and silently degrading to "no summary" would
/// hide the fact that the user's configuration is not in effect.
fn attach_summaries<I, G, R, S>(
    deps: &ListDeps<I, G, R, S>,
    entries: &mut [ListEntry],
    main_path: Option<&str>,
    warnings: &mut DeferredWarnings,
    opts: OutputOptions,
) -> Result<bool>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: SummaryRunner,
{
    // No main worktree means an empty listing: there is nothing to summarize,
    // and nowhere to read a config from.
    let Some(main_path) = main_path else {
        return Ok(false);
    };

    let config = load_vibe_config(deps.io, deps.resolver, deps.version, main_path)?;
    let Some(summary_config) = config.as_ref().and_then(|c| c.summary.as_ref()) else {
        return Ok(false);
    };
    // A `[summary]` section with no `command` is a section that configures
    // nothing; there is no column to show.
    let Some(command) = summary_config.command.as_deref().filter(|c| !c.is_empty()) else {
        return Ok(false);
    };

    let targets: Vec<SummaryTarget> = entries
        .iter()
        .map(|e| SummaryTarget {
            name: e.name.clone(),
            path: e.path.clone(),
            base: e.base.clone(),
            head: e.head.clone(),
            key: entry_key(e.head.as_deref(), e.status_payload.as_deref()),
        })
        .collect();

    let timeout = Duration::from_secs(
        summary_config
            .timeout_seconds
            .unwrap_or(DEFAULT_SUMMARY_TIMEOUT_SECONDS),
    );
    let result = resolve_summaries(
        deps.io,
        deps.summary_runner,
        &SummaryRequest {
            command,
            main_worktree_path: main_path,
            timeout,
            targets: &targets,
        },
        opts,
    );

    for message in result.warnings {
        warnings.push(message);
    }
    for entry in entries.iter_mut() {
        // Every row carries the field once the feature is on, so an unanswered
        // worktree reads as "no summary" rather than "no SUMMARY column".
        entry.summary = Some(result.by_path.get(&entry.path).cloned().unwrap_or_default());
    }

    Ok(true)
}

/// Build the ordered entry list: the current worktree first, then the rest in
/// MRU order (most recently jumped-to first), then never-visited worktrees in
/// git's own emitted order.
///
/// Also returns the MAIN worktree's path — git's first emitted entry, before any
/// reordering. Returned from here rather than re-derived with
/// `git::get_main_worktree_path` because that helper runs `git worktree list`
/// all over again, and a second enumeration could disagree with the rows just
/// built if a worktree were added between the two calls.
fn collect_entries<I, G, R, S>(
    deps: &ListDeps<I, G, R, S>,
    warnings: &mut DeferredWarnings,
) -> Result<(Vec<ListEntry>, Option<String>)>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: SummaryRunner,
{
    let worktrees = get_worktree_list(deps.git)?;
    // git lists the main worktree first; captured before the MRU reordering
    // below moves it.
    let main_path = worktrees.first().map(|w| w.path.clone());
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

    let mut entries = enrich_entries(deps.git, &sorted, deps.now_ms, warnings);
    for entry in &mut entries {
        entry.current =
            current_path.as_deref() == Some(lexical_normalize_path(&entry.path).as_str());
    }

    // Current worktree first; the MRU order established above is preserved for
    // everything else because `sort_by_key` is stable.
    entries.sort_by_key(|e| !e.current);
    Ok((entries, main_path))
}

/// Turn parsed worktrees into rows, filling BASE / AGE / STATUS from git.
///
/// The git budget is deliberately bounded at roughly `N + 4`: one
/// [`branch_ref_info`] call covers every branch's commit time AND upstream,
/// [`get_default_branch`] is resolved at most once (it costs up to two git
/// calls), and only the per-worktree status has to be asked `N` times because
/// git has no batch form for it. A naive implementation resolving each column
/// per row would be `4N`.
///
/// Runs sequentially rather than in parallel: the [`GitRunner`] seam is `&G`
/// with no `Sync` bound (the test doubles record calls through a `RefCell`), so
/// threading it would force a seam change on every existing fake for a win that
/// only matters at worktree counts nobody has.
///
/// Every git failure here degrades a CELL, never the listing: a broken worktree
/// left behind by a deleted checkout is exactly the situation a user runs `list`
/// to discover, so it must still appear as a row.
fn enrich_entries<G: GitRunner>(
    git: &G,
    worktrees: &[Worktree],
    now_ms: i64,
    warnings: &mut DeferredWarnings,
) -> Vec<ListEntry> {
    let branches: Vec<String> = worktrees.iter().filter_map(|w| w.branch.clone()).collect();
    // A failure here is not fatal: it costs the AGE and BASE columns, and an
    // empty map makes every branch look unknown, which is the correct rendering.
    let ref_info: HashMap<String, _> = branch_ref_info(git, &branches)
        .unwrap_or_default()
        .into_iter()
        .collect();

    // Resolved once, lazily: it is only needed when some branch has no upstream,
    // and it is the same answer for every row.
    let mut default_branch: Option<String> = None;
    let now_secs = now_ms / 1_000;

    worktrees
        .iter()
        .map(|w| {
            let name = match &w.branch {
                Some(branch) => branch.clone(),
                None => detached_name(&w.path),
            };

            // The commit facts: from the batched ref lookup for a branch, and
            // per-worktree for a detached HEAD (which owns no ref to enumerate).
            let commit = match &w.branch {
                Some(branch) => ref_info
                    .get(branch)
                    .map(|i| (i.committed_at_unix, i.committed_at_iso.clone())),
                None => detached_head_info(git, &w.path),
            };

            let base = match &w.branch {
                Some(branch) => ref_info
                    .get(branch)
                    .and_then(|i| i.upstream.as_deref())
                    .map(strip_remote_prefix)
                    .or_else(|| {
                        Some(
                            default_branch
                                .get_or_insert_with(|| get_default_branch(git))
                                .clone(),
                        )
                    })
                    // A branch is not based on itself; the main worktree would
                    // otherwise read "develop ← develop".
                    .filter(|base| base != branch),
                // A detached HEAD is not based on a branch in any sense we can
                // state truthfully, so BASE stays unknown rather than guessing
                // the default branch.
                None => None,
            };

            let (status, dirty_files, status_payload) = match worktree_status_z(git, &w.path) {
                Ok(payload) => {
                    let count = count_status_entries_z(&payload);
                    let label = if count == 0 {
                        STATUS_CLEAN
                    } else {
                        STATUS_DIRTY
                    };
                    (Some(label.to_string()), Some(count), Some(payload))
                }
                Err(e) => {
                    // Not sanitized here: `DeferredWarnings::push` does it for
                    // every message, and the git error `{e}` needs it just as
                    // much as the path does.
                    warnings.push(format!("Could not read status of {}: {e}", w.path));
                    (None, None, None)
                }
            };

            ListEntry {
                branch: w.branch.clone(),
                path: w.path.clone(),
                // Overwritten by the caller, which alone knows the cwd.
                current: false,
                scratch: w
                    .branch
                    .as_deref()
                    .is_some_and(|b| b.starts_with(SCRATCH_PREFIX)),
                name,
                base,
                head: Some(w.head.clone()).filter(|h| !h.is_empty()),
                last_commit_at: commit.as_ref().map(|(_, iso)| iso.clone()),
                status,
                dirty_files,
                age: commit.map(|(unix, _)| format_age(now_secs, unix)),
                // Filled in later, and only when `[summary]` is configured.
                summary: None,
                status_payload,
            }
        })
        .collect()
}

/// Label for a detached worktree: the basename of its directory.
///
/// Falls back to the whole path when there is no final component (a root path),
/// so the field is never empty.
fn detached_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Drop a `<remote>/` prefix from an upstream so BASE names a branch.
///
/// The first segment of an `upstream:short` is always the remote name (git
/// builds it as `<remote>/<branch>`), so splitting on the first `/` is exact
/// rather than a guess at "origin". A value with no `/` is already a plain
/// branch name and is returned unchanged.
fn strip_remote_prefix(upstream: &str) -> String {
    match upstream.split_once('/') {
        Some((_remote, branch)) if !branch.is_empty() => branch.to_string(),
        _ => upstream.to_string(),
    }
}

/// Number of seconds treated as a month for the AGE column (≈30 days).
const SECONDS_PER_MONTH: i64 = 30 * 86_400;

/// Number of seconds treated as a year for the AGE column (≈365 days).
const SECONDS_PER_YEAR: i64 = 365 * 86_400;

/// Render an elapsed time as a compact relative age (`3d`, `2w`, `5mo`).
///
/// Truncating (not rounding) so the value never claims more elapsed time than
/// has actually passed: a commit 47 hours old reads `1d`, never `2d`.
///
/// A commit dated in the FUTURE — which clock skew between a checkout host and
/// this machine produces routinely — reads `now` rather than a negative or
/// wrapped value.
///
/// The month and year units are display-only approximations. They exist because
/// `73w` is unreadable, and they are deliberately NOT accepted by any duration
/// input: a filter written against an approximate month would silently disagree
/// with the calendar.
pub fn format_age(now_secs: i64, commit_secs: i64) -> String {
    let elapsed = now_secs.saturating_sub(commit_secs);
    if elapsed < 60 {
        return "now".to_string();
    }
    if elapsed < 3_600 {
        return format!("{}m", elapsed / 60);
    }
    if elapsed < 86_400 {
        return format!("{}h", elapsed / 3_600);
    }
    if elapsed < 7 * 86_400 {
        return format!("{}d", elapsed / 86_400);
    }
    if elapsed < SECONDS_PER_MONTH {
        return format!("{}w", elapsed / (7 * 86_400));
    }
    if elapsed < SECONDS_PER_YEAR {
        return format!("{}mo", elapsed / SECONDS_PER_MONTH);
    }
    format!("{}y", elapsed / SECONDS_PER_YEAR)
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
/// Every cell is *sanitized* before its width is measured, so a branch name
/// carrying control characters cannot skew the alignment of the other rows, and
/// widths are counted in terminal *display* cells rather than codepoints: a CJK
/// or emoji branch name occupies two cells per character, so padding by
/// `chars().count()` would leave the following columns ragged.
///
/// No header row is printed. The columns are self-describing (`3d`, `clean`,
/// `M 2`), the rows are frequently piped into `grep`, and a header would be the
/// one line that never matches what the user is looking for.
fn render_table(entries: &[ListEntry], has_summary: bool) -> Vec<String> {
    let cells: Vec<Vec<String>> = entries
        .iter()
        .map(|e| {
            let mut row = vec![
                match &e.branch {
                    Some(b) => sanitize_for_display(b),
                    None => DETACHED_LABEL.to_string(),
                },
                e.base
                    .as_deref()
                    .map(sanitize_for_display)
                    .unwrap_or_else(|| UNKNOWN_CELL.to_string()),
                e.age.clone().unwrap_or_else(|| UNKNOWN_CELL.to_string()),
                status_cell(e),
            ];
            if has_summary {
                // Sanitized like every other cell: this text came from an
                // external command, so it is at least as attacker-influenced as
                // a branch name.
                row.push(sanitize_for_display(e.summary.as_deref().unwrap_or("")));
            }
            row
        })
        .collect();

    let column_count = 4 + usize::from(has_summary);
    // One max per column, over the sanitized text that will actually be printed.
    let widths: Vec<usize> = (0..column_count)
        .map(|col| {
            cells
                .iter()
                .filter_map(|row| row.get(col))
                .map(|cell| cell.width())
                .max()
                .unwrap_or_default()
        })
        .collect();

    entries
        .iter()
        .zip(&cells)
        .map(|(entry, row)| {
            let marker = if entry.current { CURRENT_MARKER } else { " " };
            let mut line = String::from(marker);
            for (col, cell) in row.iter().enumerate() {
                line.push(' ');
                line.push_str(cell);
                // `saturating_sub` because each width is the max over this same
                // set, so the difference can never actually go negative.
                line.push_str(&" ".repeat(widths[col].saturating_sub(cell.width())));
                line.push(' ');
            }
            line.push_str(&sanitize_for_display(&entry.path));
            if entry.scratch {
                line.push(' ');
                line.push_str(SCRATCH_LABEL);
            }
            line
        })
        .collect()
}

/// The STATUS cell: `clean`, `M <n>` for a dirty tree, or the unknown marker.
///
/// `M <n>` rather than `dirty`: the count is the actionable part (one stray file
/// versus forty is a different decision), and it fits the same column.
fn status_cell(entry: &ListEntry) -> String {
    match (entry.status.as_deref(), entry.dirty_files) {
        (Some(STATUS_DIRTY), Some(count)) => format!("M {count}"),
        (Some(STATUS_CLEAN), _) => STATUS_CLEAN.to_string(),
        _ => UNKNOWN_CELL.to_string(),
    }
}

#[cfg(test)]
#[path = "list_tests.rs"]
mod tests;
