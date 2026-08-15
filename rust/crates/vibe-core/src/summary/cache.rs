//! On-disk cache of generated summaries, one file per repository.
//!
//! Location: `<cache_dir>/vibe/summaries/<sha256 of the main worktree path>.json`
//! (see [`crate::config_path::cache_dir`]).
//!
//! ```json
//! {
//!   "version": 1,
//!   "command_hash": "<sha256 of the merged [summary] command>",
//!   "entries": {
//!     "/abs/path/to/worktree": { "key": "<head>:<sha256 of the status payload>",
//!                                "summary": "…" }
//!   }
//! }
//! ```
//!
//! # Why the file carries a `command_hash`
//!
//! Changing `[summary] command` changes what a summary MEANS, so every stored
//! value becomes a lie the moment the command is edited. A mismatch discards the
//! whole file rather than trying to reconcile per entry: there is no way to tell
//! which of the stored strings the new command would have produced.
//! `timeout_seconds` is deliberately excluded — it changes how long we wait, not
//! what the answer is.
//!
//! # Why entries are keyed by path, not by name
//!
//! `name` is the branch, or for a detached HEAD the directory basename, so two
//! detached worktrees (or a detached worktree and a same-named branch) can
//! collide. `git worktree list` guarantees paths are unique; a collision here
//! would silently show one worktree's summary on another's row.
//!
//! Why not `fs::canonicalize` those paths first: the key only has to be STABLE
//! across runs, not canonical in the filesystem's sense, and the spelling git
//! prints is canonical by construction for that purpose — it is what git
//! recorded when the worktree was created, it is identical on every run against
//! the same repository, and git is the single source of truth this whole command
//! reads from. Canonicalizing would add one `realpath` syscall per worktree per
//! run, and would have to reach the filesystem through a new seam (nothing in
//! `vibe-core` touches `std::fs` for paths outside the settings/cache stores) —
//! all to defend against a symlinked worktree path that git itself never
//! reports two different ways. The cost of being wrong is a cache miss, not a
//! wrong summary: a path that did somehow change spelling produces a fresh
//! entry and the stale one is pruned by [`SummaryCache::retain_paths`].
//!
//! # Why the entry key mixes HEAD with the status payload
//!
//! A summary must be regenerated when the worktree's content changes. HEAD alone
//! misses uncommitted edits; the `git status -z` payload alone misses a plain
//! `git commit` that leaves the tree clean. Hashing the raw `-z` bytes (the same
//! payload the STATUS column already fetched, so no extra git call) covers both.
//!
//! # Degradation
//!
//! Every read failure — missing file, bad JSON, wrong version, unreadable
//! permissions — yields an empty cache, exactly as `mru.rs` degrades. A cache
//! that cannot be read is a slow `vibe list`, never a failed one. Concurrent
//! `vibe list` runs are last-writer-wins: [`atomic_write`] keeps each file
//! internally consistent, and the only cost of losing a write is regenerating a
//! summary.
//!
//! The store is reached with `std::fs` directly rather than through the [`Io`]
//! seam, matching `settings_io.rs` and `mru.rs`: the seam abstracts the process
//! environment and the stderr/stdin channels, while the config- and cache-store
//! files are addressed by a path derived from `Io::home()` and are exercised in
//! tests through a real temp directory (`vibe_test_support::Fixture`).

use crate::atomic::atomic_write;
use crate::config_path::ensure_cache_subdir;
use crate::error::Result;
use crate::hash::hash_content;
use crate::io::Io;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Schema version of the cache document. Bumped only for a breaking change; a
/// file carrying anything else is discarded rather than migrated (it is
/// regenerable data — a migration ladder would be all cost and no benefit).
pub const CACHE_VERSION: u32 = 1;

/// Subdirectory under the vibe cache root holding the per-repository files.
const CACHE_SUBDIR: &str = "summaries";

/// One cached summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CacheEntry {
    /// `<head sha>:<sha256 of the status payload>` at the time the summary was
    /// produced.
    pub key: String,
    pub summary: String,
}

/// The whole cache document for one repository.
///
/// `BTreeMap` rather than `HashMap`: the serialized key order is then stable, so
/// two runs that change nothing produce byte-identical files (readable diffs,
/// and no spurious writes to notice).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SummaryCache {
    pub version: u32,
    pub command_hash: String,
    pub entries: BTreeMap<String, CacheEntry>,
}

impl SummaryCache {
    /// An empty cache pinned to `command_hash`.
    pub fn empty(command_hash: &str) -> Self {
        SummaryCache {
            version: CACHE_VERSION,
            command_hash: command_hash.to_string(),
            entries: BTreeMap::new(),
        }
    }

    /// The stored summary for `path`, if it was produced from `key`.
    pub fn get(&self, path: &str, key: &str) -> Option<&str> {
        self.entries
            .get(path)
            .filter(|e| e.key == key)
            .map(|e| e.summary.as_str())
    }

    /// The stored summary for `path` whatever its key.
    ///
    /// Used only for the fallback path: when the command fails or times out, a
    /// stale summary is better than a blank column, and the row is stale by
    /// definition (a fresh one is exactly what could not be produced).
    pub fn get_stale(&self, path: &str) -> Option<&str> {
        self.entries.get(path).map(|e| e.summary.as_str())
    }

    pub fn insert(&mut self, path: &str, key: &str, summary: &str) {
        self.entries.insert(
            path.to_string(),
            CacheEntry {
                key: key.to_string(),
                summary: summary.to_string(),
            },
        );
    }

    /// Drop every entry whose worktree no longer exists.
    ///
    /// Without this the file grows once per worktree ever created and is never
    /// pruned — `vibe start`/`vibe clean` cycles would leave a permanent record
    /// of every branch the user has worked on.
    pub fn retain_paths(&mut self, live: &[String]) {
        self.entries
            .retain(|path, _| live.iter().any(|p| p == path));
    }
}

/// The cache entry key for a worktree: its HEAD plus a digest of its working
/// tree state.
pub fn entry_key(head: Option<&str>, status_payload: Option<&[u8]>) -> String {
    // An unknown HEAD (no porcelain record) and an unreadable status are both
    // rendered as fixed placeholders rather than skipped: a key must still be
    // comparable, and two worktrees in the same unknown state legitimately share
    // one — they are keyed by path anyway.
    let head = head.unwrap_or("-");
    let status = hash_content(status_payload.unwrap_or(b""));
    format!("{head}:{status}")
}

/// Path of the cache file for the repository rooted at `main_worktree_path`.
///
/// The file name is a hash rather than a sanitized path: a path can contain any
/// byte a filesystem allows (including `/` and, on some systems, a newline), and
/// every sanitizing scheme either collides or produces unusable names.
fn cache_file_path(io: &impl Io, main_worktree_path: &str) -> Result<PathBuf> {
    let dir = ensure_cache_subdir(io, CACHE_SUBDIR)?;
    Ok(dir.join(format!(
        "{}.json",
        hash_content(main_worktree_path.as_bytes())
    )))
}

/// Load the cache, or an empty one on ANY failure or `command_hash` mismatch.
pub fn load_cache(io: &impl Io, main_worktree_path: &str, command_hash: &str) -> SummaryCache {
    let empty = SummaryCache::empty(command_hash);

    let Ok(path) = cache_file_path(io, main_worktree_path) else {
        return empty;
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return empty;
    };
    let Ok(cache) = serde_json::from_str::<SummaryCache>(&content) else {
        return empty;
    };
    if cache.version != CACHE_VERSION || cache.command_hash != command_hash {
        return empty;
    }
    cache
}

/// Persist the cache. Best-effort at the call site: a write failure must not
/// fail `vibe list`, so this returns the error for the caller to warn about.
pub fn save_cache(io: &impl Io, main_worktree_path: &str, cache: &SummaryCache) -> Result<()> {
    let path = cache_file_path(io, main_worktree_path)?;
    let mut content = serde_json::to_string(cache).map_err(|e| {
        crate::error::VibeError::Configuration(format!("Failed to serialize summary cache: {e}"))
    })?;
    content.push('\n');
    atomic_write(&path, content.as_bytes())
}

/// Digest of the configured command, pinning every stored summary to it.
pub fn command_hash(command: &str) -> String {
    hash_content(command.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::FakeIo;
    use vibe_test_support::Fixture;

    fn io_for(fx: &Fixture) -> FakeIo {
        FakeIo::new().with_env("HOME", fx.path().to_str().unwrap())
    }

    #[test]
    fn a_saved_cache_round_trips() {
        let fx = Fixture::new();
        let io = io_for(&fx);
        let hash = command_hash("./s.sh");
        let mut cache = SummaryCache::empty(&hash);
        cache.insert("/repo/a", "head1:st", "did a thing");
        save_cache(&io, "/repo", &cache).unwrap();

        let loaded = load_cache(&io, "/repo", &hash);
        assert_eq!(loaded.get("/repo/a", "head1:st"), Some("did a thing"));
    }

    #[test]
    fn a_different_key_is_a_miss_but_is_still_available_as_stale() {
        let fx = Fixture::new();
        let io = io_for(&fx);
        let hash = command_hash("./s.sh");
        let mut cache = SummaryCache::empty(&hash);
        cache.insert("/repo/a", "head1:st", "old summary");
        save_cache(&io, "/repo", &cache).unwrap();

        let loaded = load_cache(&io, "/repo", &hash);
        assert_eq!(loaded.get("/repo/a", "head2:st"), None);
        assert_eq!(loaded.get_stale("/repo/a"), Some("old summary"));
    }

    /// What it guarantees: editing `[summary] command` invalidates every stored
    /// summary, because a summary produced by the old command says nothing about
    /// what the new one means.
    #[test]
    fn a_changed_command_discards_the_whole_file() {
        let fx = Fixture::new();
        let io = io_for(&fx);
        let mut cache = SummaryCache::empty(&command_hash("./old.sh"));
        cache.insert("/repo/a", "k", "from the old command");
        save_cache(&io, "/repo", &cache).unwrap();

        let loaded = load_cache(&io, "/repo", &command_hash("./new.sh"));
        assert!(loaded.entries.is_empty());
        assert_eq!(loaded.command_hash, command_hash("./new.sh"));
    }

    /// What it guarantees: a corrupt or truncated cache degrades to "no cache",
    /// exactly as a corrupt MRU store degrades to git order.
    #[test]
    fn a_corrupt_file_loads_as_empty() {
        let fx = Fixture::new();
        let io = io_for(&fx);
        let path = cache_file_path(&io, "/repo").unwrap();
        std::fs::write(&path, "{not json").unwrap();
        assert!(load_cache(&io, "/repo", &command_hash("c"))
            .entries
            .is_empty());
    }

    #[test]
    fn a_future_version_loads_as_empty() {
        let fx = Fixture::new();
        let io = io_for(&fx);
        let path = cache_file_path(&io, "/repo").unwrap();
        std::fs::write(
            &path,
            r#"{"version":99,"command_hash":"x","entries":{"/a":{"key":"k","summary":"s"}}}"#,
        )
        .unwrap();
        assert!(load_cache(&io, "/repo", "x").entries.is_empty());
    }

    #[test]
    fn a_missing_file_loads_as_empty() {
        let fx = Fixture::new();
        let io = io_for(&fx);
        assert!(load_cache(&io, "/never-written", "x").entries.is_empty());
    }

    /// What it guarantees: the file cannot grow without bound as worktrees come
    /// and go.
    #[test]
    fn retain_drops_entries_for_deleted_worktrees() {
        let mut cache = SummaryCache::empty("h");
        cache.insert("/repo/live", "k", "a");
        cache.insert("/repo/gone", "k", "b");
        cache.retain_paths(&["/repo/live".to_string()]);
        assert_eq!(cache.entries.len(), 1);
        assert!(cache.entries.contains_key("/repo/live"));
    }

    #[test]
    fn the_entry_key_changes_with_head_and_with_the_working_tree() {
        let base = entry_key(Some("abc"), Some(b""));
        assert_ne!(base, entry_key(Some("def"), Some(b"")));
        assert_ne!(base, entry_key(Some("abc"), Some(b" M a.txt\0")));
        // Same inputs, same key.
        assert_eq!(base, entry_key(Some("abc"), Some(b"")));
    }

    #[test]
    fn an_unknown_head_or_status_still_produces_a_comparable_key() {
        assert_eq!(entry_key(None, None), entry_key(None, None));
        assert_ne!(entry_key(None, None), entry_key(Some("abc"), None));
    }

    #[test]
    fn two_repositories_use_separate_files() {
        let fx = Fixture::new();
        let io = io_for(&fx);
        assert_ne!(
            cache_file_path(&io, "/repo/one").unwrap(),
            cache_file_path(&io, "/repo/two").unwrap()
        );
    }
}
