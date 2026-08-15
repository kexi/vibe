//! The `[summary]` batch protocol: turn a list of worktrees into one summary
//! string each, by running a user-configured command at most once per
//! `vibe list`.
//!
//! # The contract
//!
//! The command receives on **stdin** a single JSON document naming only the
//! worktrees whose summary is not already cached:
//!
//! ```json
//! { "worktrees": [ { "name": "feat/login",
//!                    "path": "/abs/path",
//!                    "base": "develop",
//!                    "head": "0f1e2d3…" } ] }
//! ```
//!
//! `base` and `head` are `null` when unknown; `name` and `path` are always
//! strings. It must print on **stdout** a JSON object mapping `name` to the
//! summary text:
//!
//! ```json
//! { "feat/login": "Adds the login form" }
//! ```
//!
//! A name the command omits simply has no summary (blank cell, nothing cached),
//! so a command can answer for the worktrees it understands and stay silent
//! about the rest.
//!
//! # Why one batch instead of one call per worktree
//!
//! The interesting summary commands are LLM calls and repository-wide queries,
//! where N invocations cost N times the latency and N times the money. One call
//! also lets the command see the whole set and answer relatively ("the only
//! branch touching the parser").
//!
//! # Why `name` keys the answer rather than `path`
//!
//! The contract predates this implementation (#408) and a name is what a shell
//! one-liner can comfortably echo back; paths are long, absolute and
//! machine-specific. The cost is that names are not guaranteed unique — two
//! detached worktrees share a basename — so a batch containing a duplicate name
//! EXCLUDES those worktrees from the request entirely (with a verbose note)
//! rather than risking one worktree's summary being displayed on another's row.
//! A missing summary is a blank cell; a wrong one is misinformation.
//!
//! # The command's stdout is untrusted input
//!
//! It is arbitrary program output that lands in a terminal, so every layer is
//! bounded before anything is stored or shown:
//!
//! - **1 MiB cap** on stdout — a command printing a core dump or an infinite
//!   stream must not be buffered into a `String` that exhausts memory.
//! - **Object of strings only** — an array, a nested object or a number is a
//!   contract violation, not something to coerce. Coercion would let a value's
//!   shape decide how it renders.
//! - **First line only, then 500 chars** — a summary occupies one table cell.
//!   A multi-line value would break the row alignment the whole table depends
//!   on, and an unbounded one would push every other column off screen.
//! - Terminal control characters are neutralized at the render site
//!   (`sanitize_for_display`), the same guard the branch and path columns use.

pub mod cache;
pub mod runner;

use crate::error::Result;
use crate::io::Io;
use crate::output::{verbose_log, OutputOptions};
use runner::{SummaryInvocation, SummaryRunner};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::time::Duration;

pub use cache::{command_hash, entry_key, load_cache, save_cache, SummaryCache};
pub use runner::{RealSummaryRunner, SummaryOutput};

#[cfg(any(test, feature = "test-util"))]
pub use runner::{FakeSummaryRunner, SummaryCall};

/// Largest stdout accepted from the summary command.
pub const MAX_SUMMARY_STDOUT_BYTES: usize = 1024 * 1024;

/// Longest summary kept, in characters (not bytes: the cap exists to bound the
/// TABLE, and a byte cap would truncate a multi-byte character mid-sequence).
pub const MAX_SUMMARY_CHARS: usize = 500;

/// One worktree as the batch protocol describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryTarget {
    pub name: String,
    pub path: String,
    pub base: Option<String>,
    pub head: Option<String>,
    /// The cache key for this worktree's current state (see
    /// [`cache::entry_key`]).
    pub key: String,
}

/// What [`resolve_summaries`] needs from the caller.
pub struct SummaryRequest<'a> {
    /// `[summary] command`, already merged from `.vibe.toml`/`.vibe.local.toml`.
    pub command: &'a str,
    /// Where the command runs: the main worktree.
    pub main_worktree_path: &'a str,
    pub timeout: Duration,
    pub targets: &'a [SummaryTarget],
}

/// Summaries keyed by worktree PATH, plus any warning the caller should surface.
///
/// Warnings are returned rather than written: `vibe list --json` puts its
/// payload on the same stream as diagnostics, so only the caller knows whether
/// a warning may be emitted (see `DeferredWarnings` in `commands/list.rs`).
#[derive(Debug, Default)]
pub struct SummaryResult {
    pub by_path: HashMap<String, String>,
    pub warnings: Vec<String>,
}

/// Produce a summary for every target, running the command at most once.
///
/// Order of operations: consult the cache, ask the command about the misses
/// only, merge, then persist. A full cache hit never spawns anything — that is
/// the whole point of the cache, and the [`FakeSummaryRunner`] call log is what
/// proves it in tests.
pub fn resolve_summaries<I: Io, R: SummaryRunner>(
    io: &I,
    runner: &R,
    request: &SummaryRequest,
    opts: OutputOptions,
) -> SummaryResult {
    let mut result = SummaryResult::default();

    let hash = command_hash(request.command);
    let mut cache = load_cache(io, request.main_worktree_path, &hash);

    // Split into hits (answered from disk) and misses (must be asked for).
    let mut misses: Vec<&SummaryTarget> = Vec::new();
    for target in request.targets {
        match cache.get(&target.path, &target.key) {
            Some(summary) => {
                result
                    .by_path
                    .insert(target.path.clone(), summary.to_string());
            }
            None => misses.push(target),
        }
    }

    let (askable, dropped) = drop_duplicate_names(&misses);
    for name in dropped {
        verbose_log(
            io,
            &format!(
                "Skipping summary for worktrees sharing the name {name:?}: \
                 the summary protocol keys answers by name."
            ),
            opts,
        );
    }

    if askable.is_empty() {
        // Nothing to ask: either everything was cached, or every miss was
        // ambiguous. Either way the command must not run — but the prune still
        // has to happen, or a worktree removed while its summary was cached
        // would keep its entry for as long as nothing else was ever asked.
        persist(io, request, &mut cache, opts);
        return result;
    }

    let payload = build_stdin_payload(&askable);
    let output = runner.run_summary(&SummaryInvocation {
        command: request.command,
        cwd: request.main_worktree_path,
        stdin_payload: &payload,
        timeout: request.timeout,
    });

    let parsed = match interpret(output, request.timeout, askable.len()) {
        Ok(map) => map,
        Err(message) => {
            result.warnings.push(message);
            // Fall back to whatever the cache still holds, even though it is
            // stale: on the row of a worktree the user knows they just changed,
            // a slightly old summary carries more than an empty cell.
            for target in &askable {
                if let Some(stale) = cache.get_stale(&target.path) {
                    result
                        .by_path
                        .insert(target.path.clone(), stale.to_string());
                }
            }
            return result;
        }
    };

    for target in &askable {
        // A name the command did not answer for gets no summary and no cache
        // entry, so the next run asks again.
        let Some(summary) = parsed.get(&target.name) else {
            continue;
        };
        let summary = truncate_summary(summary);
        cache.insert(&target.path, &target.key, &summary);
        result.by_path.insert(target.path.clone(), summary);
    }

    persist(io, request, &mut cache, opts);
    result
}

/// Prune entries for worktrees that no longer exist, then write the cache.
///
/// Called on every path that consulted the cache, including the full-hit one:
/// otherwise a worktree deleted while its summary was cached would keep its
/// entry for as long as no other worktree ever changed.
fn persist<I: Io>(io: &I, request: &SummaryRequest, cache: &mut SummaryCache, opts: OutputOptions) {
    let live: Vec<String> = request.targets.iter().map(|t| t.path.clone()).collect();
    cache.retain_paths(&live);
    if let Err(e) = save_cache(io, request.main_worktree_path, cache) {
        // A cache we cannot write costs performance, never correctness.
        verbose_log(io, &format!("Could not write the summary cache: {e}"), opts);
    }
}

/// Remove every target whose `name` is not unique within the batch.
///
/// Returns the askable targets and the names that were dropped (deduplicated,
/// for one message per collision rather than one per worktree).
fn drop_duplicate_names<'a>(
    targets: &[&'a SummaryTarget],
) -> (Vec<&'a SummaryTarget>, Vec<String>) {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for t in targets {
        *counts.entry(t.name.as_str()).or_default() += 1;
    }

    let mut askable = Vec::new();
    let mut dropped: Vec<String> = Vec::new();
    for t in targets {
        if counts.get(t.name.as_str()).copied().unwrap_or(0) > 1 {
            if !dropped.iter().any(|n| n == &t.name) {
                dropped.push(t.name.clone());
            }
            continue;
        }
        askable.push(*t);
    }
    (askable, dropped)
}

/// Build the stdin document for a batch.
fn build_stdin_payload(targets: &[&SummaryTarget]) -> String {
    let worktrees: Vec<Value> = targets
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "path": t.path,
                // Explicit nulls rather than omitted keys: a consumer written in
                // `jq` or JS can then read `.base` unconditionally instead of
                // branching on presence.
                "base": t.base,
                "head": t.head,
            })
        })
        .collect();
    // `to_string` (not pretty): the document is machine-to-machine, and a
    // single line keeps a large batch cheap to write through the pipe.
    Value::Object(Map::from_iter([(
        "worktrees".to_string(),
        Value::Array(worktrees),
    )]))
    .to_string()
}

/// Turn a runner result into the name→summary map, or a warning message.
fn interpret(
    output: Result<runner::SummaryOutput>,
    timeout: Duration,
    asked: usize,
) -> std::result::Result<HashMap<String, String>, String> {
    let output = match output {
        Ok(output) => output,
        Err(e) => return Err(format!("Summary command could not be run: {e}")),
    };

    if output.timed_out {
        return Err(format!(
            "Summary command timed out after {}s; showing cached summaries.",
            timeout.as_secs()
        ));
    }
    if output.code != 0 {
        let detail = first_line(&output.stderr);
        return Err(format!(
            "Summary command exited with code {}{}",
            output.code,
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ));
    }

    parse_summary_stdout(&output.stdout, asked)
}

/// How many keys the answer may carry, per worktree actually asked about.
///
/// A slack factor rather than an exact match: a command legitimately answers for
/// names it was not asked about this run (a cached one it re-derived anyway, or
/// a stale name from its own bookkeeping), and rejecting the whole batch over
/// that would be hostile. Four is generous for those cases and still turns
/// "unbounded map from an untrusted process" into a bound proportional to the
/// request we made.
const MAX_SUMMARY_KEYS_PER_TARGET: usize = 4;

/// Parse the command's stdout into name→summary, enforcing every bound.
///
/// `asked` is how many worktrees were named in the request; it bounds how large
/// a map the answer may be (see [`MAX_SUMMARY_KEYS_PER_TARGET`]). The check is
/// on the PARSED map rather than pre-parse, because JSON gives no way to count
/// keys without parsing — the byte cap is what keeps that parse bounded.
pub fn parse_summary_stdout(
    stdout: &str,
    asked: usize,
) -> std::result::Result<HashMap<String, String>, String> {
    if stdout.len() > MAX_SUMMARY_STDOUT_BYTES {
        return Err(format!(
            "Summary command produced more than {} bytes of output; ignoring it.",
            MAX_SUMMARY_STDOUT_BYTES
        ));
    }

    let value: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Summary command did not produce valid JSON: {e}"))?;

    let Value::Object(map) = value else {
        return Err("Summary command must print a JSON object of name → summary.".to_string());
    };

    let max_keys = asked.saturating_mul(MAX_SUMMARY_KEYS_PER_TARGET);
    if map.len() > max_keys {
        return Err(format!(
            "Summary command answered with {} entries for {asked} worktree(s); ignoring it.",
            map.len()
        ));
    }

    let mut out = HashMap::new();
    for (name, value) in map {
        // Why not coerce a number or a bool: the contract is string values, and
        // accepting anything JSON can express would make the rendering of a cell
        // depend on the type the command happened to emit.
        let Value::String(summary) = value else {
            return Err(format!(
                "Summary for {name:?} must be a string, not {}.",
                json_type_name(&value)
            ));
        };
        out.insert(name, summary);
    }
    Ok(out)
}

/// A summary is one table cell: first line, at most [`MAX_SUMMARY_CHARS`].
pub fn truncate_summary(summary: &str) -> String {
    let first = first_line(summary);
    if first.chars().count() <= MAX_SUMMARY_CHARS {
        return first;
    }
    // `chars().take` rather than byte slicing: a byte cut can land inside a
    // multi-byte character and produce invalid UTF-8.
    let mut out: String = first.chars().take(MAX_SUMMARY_CHARS - 1).collect();
    out.push('…');
    out
}

/// The text up to the first line break (`\n` or a bare `\r`), trimmed.
fn first_line(text: &str) -> String {
    text.split(['\n', '\r'])
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Human name of a JSON value's type, for the contract-violation message.
fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;
