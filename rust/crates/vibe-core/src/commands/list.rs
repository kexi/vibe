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
//! # Divergences from the original request (#408)
//!
//! The default order stays "current first, then MRU, then git order" rather
//! than the age ordering #408 proposed: `list` and `jump` are meant to present
//! the same world, and `jump`'s selection prompt is MRU-ordered. Age ordering
//! is available as an opt-in sort instead.
//!
//! # Filtering, sorting and limiting
//!
//! Selection is a pipeline of pure functions applied in a fixed order:
//! **filter (AND) → sort → reverse → limit**. Reversing before limiting is what
//! makes "the five oldest worktrees" expressible as
//! `--sort age --reverse --limit 5`; the other order would take the five
//! newest and then print them backwards, which is a different set. Every stage
//! operates on the already-enriched rows, so a filter and the JSON payload can
//! never disagree about a worktree's status or base.
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
use crate::error::{Result, VibeError};
use crate::git::{
    branch_ref_info, count_status_entries_z, detached_head_info, get_default_branch,
    get_worktree_list, is_inside_worktree, is_resolved_oid, lexical_normalize_path,
    worktree_status_z, GitRunner, Worktree,
};
use crate::io::Io;
use crate::mru::{load_mru_data, sort_by_mru};
use crate::output::{report_log, sanitize_for_display, verbose_log, warn_log, OutputOptions};
use serde::Serialize;
use std::collections::HashMap;
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
    /// The commit sha the worktree's HEAD points at, or `None` when there is no
    /// commit to name: the porcelain carried no `HEAD` record, or the branch is
    /// unborn (see [`is_resolved_oid`]).
    ///
    /// `Option` rather than the raw porcelain value: every other unknown on this
    /// struct is `null` in JSON, and a consumer checking one field for `null` and
    /// another for `""` is being asked to remember an inconsistency for no
    /// reason. The unborn case is worse than untidy — git spells it as the NULL
    /// OID, which is shaped exactly like a real sha, so publishing it verbatim
    /// hands consumers a value `git show` rejects. The published contract is
    /// "a commit sha, or null".
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
    /// The tip commit's committer date in epoch seconds.
    ///
    /// Not serialized for the same reason as `age`: `last_commit_at` already
    /// publishes the instant, in a format that is unambiguous without knowing
    /// which epoch we mean. It is carried on the row so `--recent`/`--stale`
    /// and `--sort age` can compare integers instead of re-parsing an ISO
    /// string that git, not we, formatted.
    #[serde(skip)]
    pub commit_secs: Option<i64>,
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
    /// Current wall-clock in epoch milliseconds, for the AGE column.
    pub now_ms: i64,
}

/// Warnings held back until the output mode is known.
///
/// In `--json` mode the payload is the ONLY thing on stderr (the same stream the
/// diagnostics use), so a warning written as it happens would prepend non-JSON
/// bytes to the document. Collecting instead of writing makes that structural: a
/// warning added anywhere in the enrichment path cannot corrupt the payload,
/// because the only flush point knows whether text mode is in effect.
#[derive(Debug, Default)]
struct DeferredWarnings {
    messages: Vec<String>,
}

impl DeferredWarnings {
    fn push(&mut self, message: String) {
        self.messages.push(message);
    }

    /// Emit everything collected. Called only on the text-mode path.
    fn flush(self, io: &impl Io) {
        for message in self.messages {
            warn_log(io, &message);
        }
    }
}

/// The sort key requested by `--sort`.
///
/// Deliberately NOT `Option<ListSort>` folded into a "default" variant: the
/// absence of `--sort` means "keep the current-first MRU order", which is not a
/// key at all, and modelling it as one would force every comparator to carry a
/// branch for a case it can never see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListSort {
    /// Newest tip commit first.
    Age,
    /// Lexicographic by [`ListEntry::name`].
    Name,
    /// Dirty worktrees first, most changed first.
    Status,
}

/// Everything `--dirty`/`--clean`/`--base`/`--recent`/`--stale` ask for.
///
/// `--dirty` and `--clean` are two booleans rather than one tri-state because
/// clap already proves they cannot both be set (`conflicts_with`), and a
/// tri-state would move that guarantee into a runtime invariant this module
/// would have to restate.
#[derive(Debug, Default, Clone)]
pub struct ListFilter {
    pub dirty: bool,
    pub clean: bool,
    /// Match rows whose resolved BASE equals this branch, read either verbatim
    /// or with a remote prefix removed — see [`base_matches`], which explains
    /// why the argument cannot simply be stripped.
    pub base: Option<String>,
    /// Keep rows whose tip commit is no older than this.
    pub recent: Option<std::time::Duration>,
    /// Keep rows whose tip commit is strictly older than this.
    pub stale: Option<std::time::Duration>,
}

/// The full selection request: what to keep, in what order, and how much.
#[derive(Debug, Default, Clone)]
pub struct ListOptions {
    pub filter: ListFilter,
    pub sort: Option<ListSort>,
    pub reverse: bool,
    /// Maximum rows to display. Guaranteed `>= 1` by the CLI's value parser, so
    /// this module never has to decide what `--limit 0` would mean.
    pub limit: Option<usize>,
}

/// Run `vibe list [--json]` with the given selection.
pub fn list_command<I, G>(
    deps: &ListDeps<I, G>,
    json: bool,
    options: &ListOptions,
    opts: OutputOptions,
) -> Result<Outcome>
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

    let mut warnings = DeferredWarnings::default();
    let entries = collect_entries(deps, &mut warnings)?;
    // Applied to BOTH output modes: `--json` is a rendering choice, not a
    // different query, so a script and a human passing the same flags must be
    // looking at the same set of worktrees.
    let entries = select_entries(entries, options, deps.now_ms / 1_000);

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
        // Distinguished on purpose: "no worktrees" and "your filter matched
        // nothing" call for different next actions, and reporting the first when
        // the second is true reads as a broken repository.
        report_log(
            deps.io,
            if options.filter.is_active() {
                "No worktrees matched the given filters."
            } else {
                "No worktrees found."
            },
        );
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
fn collect_entries<I, G>(
    deps: &ListDeps<I, G>,
    warnings: &mut DeferredWarnings,
) -> Result<Vec<ListEntry>>
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

    let mut entries = enrich_entries(deps.git, &sorted, deps.now_ms, warnings);
    for entry in &mut entries {
        entry.current =
            current_path.as_deref() == Some(lexical_normalize_path(&entry.path).as_str());
    }

    // Current worktree first; the MRU order established above is preserved for
    // everything else because `sort_by_key` is stable.
    entries.sort_by_key(|e| !e.current);
    Ok(entries)
}

impl ListFilter {
    /// Whether any filter was requested at all.
    fn is_active(&self) -> bool {
        self.dirty
            || self.clean
            || self.base.is_some()
            || self.recent.is_some()
            || self.stale.is_some()
    }
}

/// Apply the whole selection pipeline: **filter → sort → reverse → limit**.
///
/// Pure: given the same rows, options and instant it produces the same answer,
/// which is what lets the whole flag surface be tested without a git or an
/// [`Io`].
pub fn select_entries(
    entries: Vec<ListEntry>,
    options: &ListOptions,
    now_secs: i64,
) -> Vec<ListEntry> {
    let mut entries = apply_filters(entries, &options.filter, now_secs);
    apply_sort(&mut entries, options.sort);
    if options.reverse {
        // Reverses the FINAL display order, whatever produced it — including
        // the default current-first MRU order, so `--reverse` alone is a
        // meaningful request rather than an error.
        entries.reverse();
        if options.sort == Some(ListSort::Age) {
            // ...except for the rows with no age. `--sort age --reverse` means
            // "oldest first"; a row whose tip commit is unknown is not the
            // oldest worktree, it is a worktree the question does not apply to,
            // so it stays at the bottom in both directions — and, crucially,
            // `--limit 5` then still returns five *answers*.
            pin_unknown_age_last(&mut entries);
        }
    }
    if let Some(limit) = options.limit {
        entries.truncate(limit);
    }
    entries
}

/// Move every row with no known commit time to the end, preserving the relative
/// order within both groups.
fn pin_unknown_age_last(entries: &mut Vec<ListEntry>) {
    let (known, unknown): (Vec<ListEntry>, Vec<ListEntry>) = std::mem::take(entries)
        .into_iter()
        .partition(|e| e.commit_secs.is_some());
    entries.extend(known);
    entries.extend(unknown);
}

/// Keep the rows matching EVERY requested predicate.
///
/// AND, not OR: each flag narrows the question the user is asking
/// (`--recent 1w --dirty` is "what did I touch this week and leave unfinished"),
/// and an OR would make adding a flag return *more* rows, which no other filter
/// surface behaves like.
pub fn apply_filters(
    entries: Vec<ListEntry>,
    filter: &ListFilter,
    now_secs: i64,
) -> Vec<ListEntry> {
    entries
        .into_iter()
        .filter(|e| matches_filter(e, filter, now_secs))
        .collect()
}

/// Whether one row satisfies every active predicate.
fn matches_filter(entry: &ListEntry, filter: &ListFilter, now_secs: i64) -> bool {
    // An UNKNOWN status is excluded by BOTH `--dirty` and `--clean`. Defaulting
    // it either way would put a worktree git could not read into an answer that
    // claims to know its state; a user asking "what is dirty" is better served
    // by a short list than by a confident wrong one (the unfiltered listing
    // still shows the row, with `-`, and warns).
    if filter.dirty && entry.status.as_deref() != Some(STATUS_DIRTY) {
        return false;
    }
    if filter.clean && entry.status.as_deref() != Some(STATUS_CLEAN) {
        return false;
    }

    if let Some(wanted) = &filter.base {
        // A detached HEAD has no base at all, so it is excluded by any
        // `--base`, never matched by an "unknown means anything" rule.
        match &entry.base {
            Some(base) => {
                if !base_matches(base, wanted) {
                    return false;
                }
            }
            None => return false,
        }
    }

    // A row with no tip commit (an unborn branch, or a worktree whose log could
    // not be read) matches NEITHER `--recent` nor `--stale`: both questions are
    // about a commit date this row does not have, and answering them would mean
    // inventing one.
    if let Some(window) = filter.recent {
        let Some(commit) = entry.commit_secs else {
            return false;
        };
        if !is_recent(now_secs, commit, window) {
            return false;
        }
    }
    if let Some(window) = filter.stale {
        let Some(commit) = entry.commit_secs else {
            return false;
        };
        if is_recent(now_secs, commit, window) {
            return false;
        }
    }

    true
}

/// `now − commit <= window`, the exact complement of "stale".
///
/// `saturating_sub` makes a commit dated in the FUTURE (routine clock skew
/// between the machine that made it and this one) read as elapsed `0` — i.e.
/// recent — matching what the AGE column already renders as `now`. The two must
/// agree, or `--recent 1h` would hide a row the table calls `now`.
fn is_recent(now_secs: i64, commit_secs: i64, window: std::time::Duration) -> bool {
    let elapsed = now_secs.saturating_sub(commit_secs).max(0);
    // `as i64` is safe for every duration the parser can build: it rejects
    // anything above `u64::MAX` seconds only, so clamp rather than wrap.
    let window_secs = i64::try_from(window.as_secs()).unwrap_or(i64::MAX);
    elapsed <= window_secs
}

/// Reorder the rows in place for `--sort`, leaving them untouched when no sort
/// was requested.
///
/// A requested sort REPLACES the default ordering entirely, including the
/// current-worktree-first rule: `--sort age` promises the newest row first, and
/// silently exempting one row from that promise would make the output impossible
/// to reason about (and would move whichever worktree you happened to be in).
///
/// Every comparator is total, ending in a name tie-break and then a PATH one, so
/// the result never depends on the incoming MRU order. Path is the last resort
/// rather than name because `name` is not unique — two detached worktrees in
/// sibling directories with the same basename share a name, and without the path
/// their relative order would still be decided by which one was jumped to more
/// recently. Path is unique across `git worktree list` by construction.
pub fn apply_sort(entries: &mut [ListEntry], sort: Option<ListSort>) {
    let Some(sort) = sort else {
        return;
    };
    match sort {
        // Newest first. `None` ages sort AFTER every known age — see
        // `age_rank`.
        ListSort::Age => entries.sort_by(|a, b| {
            age_rank(a)
                .cmp(&age_rank(b))
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.path.cmp(&b.path))
        }),
        ListSort::Name => {
            entries.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)))
        }
        // Dirty first, then most-changed first, then by name.
        ListSort::Status => entries.sort_by(|a, b| {
            status_rank(a)
                .cmp(&status_rank(b))
                .then_with(|| b.dirty_files.unwrap_or(0).cmp(&a.dirty_files.unwrap_or(0)))
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.path.cmp(&b.path))
        }),
    }
}

/// Sort key for `--sort age`: newest first, unknown last.
///
/// Encoded as `(is_unknown, negated_commit_time)` so a single ascending sort
/// expresses both rules. `--reverse` would flip the unknown group to the top,
/// which [`pin_unknown_age_last`] undoes.
fn age_rank(entry: &ListEntry) -> (bool, i64) {
    match entry.commit_secs {
        // Negated so a LARGER timestamp (more recent) sorts first.
        Some(secs) => (false, secs.saturating_neg()),
        None => (true, 0),
    }
}

/// Sort key for `--sort status`: dirty (0) before clean (1) before unknown (2).
fn status_rank(entry: &ListEntry) -> u8 {
    match entry.status.as_deref() {
        Some(STATUS_DIRTY) => 0,
        Some(STATUS_CLEAN) => 1,
        _ => 2,
    }
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
    // A failure here is not fatal — it costs the AGE and BASE columns — but it
    // is kept DISTINCT from "the call worked and this branch had no upstream".
    //
    // Why not `unwrap_or_default()`: an empty map is indistinguishable from
    // "every branch tracks nothing", which sends every row down the
    // default-branch fallback below. `list` would then assert that each worktree
    // is based on `develop` on the strength of a git call that never answered.
    // A stated fact that happens to be wrong is worse than a `-`, so a failed
    // call suppresses the fallback entirely and every BASE degrades to unknown.
    // A per-branch MISS (unborn branch, ref genuinely absent) is a different
    // thing and still falls back, because there the call did answer.
    let ref_info: Option<HashMap<String, _>> = branch_ref_info(git, &branches)
        .ok()
        .map(|entries| entries.into_iter().collect());
    let ref_lookup_failed = ref_info.is_none();
    let ref_info = ref_info.unwrap_or_default();

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
                // The ref lookup never answered, so nothing is known about ANY
                // branch's upstream and the fallback would be a guess.
                Some(_) if ref_lookup_failed => None,
                Some(branch) => ref_info
                    .get(branch)
                    // Already a plain branch name: `branch_ref_info` resolves it
                    // from the full refname plus git's own remote name, so there
                    // is no prefix left here to guess at.
                    .and_then(|i| i.upstream.clone())
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

            let (status, dirty_files) = match worktree_status_z(git, &w.path) {
                Ok(payload) => {
                    let count = count_status_entries_z(&payload);
                    let label = if count == 0 {
                        STATUS_CLEAN
                    } else {
                        STATUS_DIRTY
                    };
                    (Some(label.to_string()), Some(count))
                }
                Err(e) => {
                    // Sanitized as a WHOLE, after formatting: `e` is git's own
                    // stderr text, which quotes back the path that provoked it,
                    // so sanitizing only the interpolated path would let the
                    // very same control characters through in git's copy of it.
                    warnings.push(sanitize_for_display(&format!(
                        "Could not read status of {}: {e}",
                        w.path
                    )));
                    (None, None)
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
                head: Some(w.head.clone()).filter(|h| is_resolved_oid(h)),
                last_commit_at: commit.as_ref().map(|(_, iso)| iso.clone()),
                status,
                dirty_files,
                age: commit.as_ref().map(|(unix, _)| format_age(now_secs, *unix)),
                commit_secs: commit.map(|(unix, _)| unix),
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

/// Whether a `--base` argument selects a row whose resolved BASE is `base`.
///
/// Accepts the argument EITHER verbatim or with its first path segment removed,
/// because those two readings cannot be told apart from the argument alone:
/// `origin/develop` is a remote-qualified ref, while `release/next` is a plain
/// branch whose name happens to contain a slash, and both are spelled
/// `<word>/<word>`. Stripping unconditionally silently rewrote
/// `--base release/next` into `--base next` and matched nothing.
///
/// Trying both readings costs one extra comparison and makes every spelling a
/// user can reasonably type work: `develop`, `origin/develop`, `release/next`
/// and `origin/release/next`.
///
/// The false-positive this admits — `--base origin/develop` also matching a
/// local branch literally named `origin/develop` — requires a branch named after
/// a remote, and surfacing an extra row is a far better failure than silently
/// returning none.
///
/// # Scope
///
/// This is a HEURISTIC on untrusted user input, and it is the only thing in this
/// module that guesses at a remote prefix. It is deliberately NOT the mechanism
/// the BASE column uses: that side resolves an upstream exactly, from the full
/// refname plus git's own `%(upstream:remotename)`, and needs no guessing. Do
/// not generalize this helper back onto the upstream path — the two problems
/// only look alike.
fn base_matches(base: &str, wanted: &str) -> bool {
    // Drop the first `<segment>/` — the position a remote name would occupy.
    // An argument with no `/`, or nothing after it, has no alternate reading.
    let without_leading_segment = match wanted.split_once('/') {
        Some((_maybe_remote, rest)) if !rest.is_empty() => Some(rest),
        _ => None,
    };
    base == wanted || without_leading_segment == Some(base)
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
fn render_table(entries: &[ListEntry]) -> Vec<String> {
    let cells: Vec<[String; 4]> = entries
        .iter()
        .map(|e| {
            [
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
            ]
        })
        .collect();

    // One max per column, over the sanitized text that will actually be printed.
    let widths: [usize; 4] = std::array::from_fn(|col| {
        cells
            .iter()
            .map(|row| row[col].width())
            .max()
            .unwrap_or_default()
    });

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
