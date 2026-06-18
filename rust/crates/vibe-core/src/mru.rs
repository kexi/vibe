//! Most-recently-used worktree tracking (`mru.json`).
//!
//! Ported from `packages/core/src/utils/mru.ts`. `jump` records each successful
//! navigation and sorts ambiguous matches so the most-recently-used worktree is
//! offered first. The clock is injected (`now_ms` parameter) rather than read
//! inside, so recording is deterministic in tests; the binary supplies the real
//! time. Loads tolerate a missing or corrupt file by returning an empty list.

use crate::atomic::atomic_write;
use crate::config_path;
use crate::error::Result;
use crate::io::Io;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

/// Max MRU entries kept (oldest dropped first).
pub const MAX_MRU_ENTRIES: usize = 50;

/// A recently-used worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MruEntry {
    pub branch: String,
    pub path: String,
    /// Unix epoch milliseconds (TS `Date.now()`).
    pub timestamp: i64,
}

fn mru_file_path(home: &str) -> Result<PathBuf> {
    Ok(config_path::config_dir(home)?.join("mru.json"))
}

/// Load MRU entries, returning `[]` on any error (missing file, bad JSON, or a
/// non-array root), and filtering out entries missing required fields.
pub fn load_mru_data(io: &impl Io) -> Vec<MruEntry> {
    let Some(home) = io.home().filter(|h| !h.is_empty()) else {
        return vec![];
    };
    let Ok(path) = mru_file_path(&home) else {
        return vec![];
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return vec![];
    };
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return vec![];
    };
    let Some(array) = value.as_array() else {
        return vec![];
    };

    // Keep only well-formed entries (branch:str, path:str, timestamp:number).
    array.iter().filter_map(parse_entry).collect()
}

/// Parse one JSON value into an `MruEntry`, or `None` if any field is wrong.
fn parse_entry(value: &Value) -> Option<MruEntry> {
    let branch = value.get("branch")?.as_str()?.to_string();
    let path = value.get("path")?.as_str()?.to_string();
    let timestamp = value.get("timestamp")?.as_i64()?;
    Some(MruEntry {
        branch,
        path,
        timestamp,
    })
}

/// Record a navigation: dedup by path, prepend the newest, cap at
/// [`MAX_MRU_ENTRIES`], then atomically write. `now_ms` is the timestamp to use.
pub fn record_mru_entry(io: &impl Io, branch: &str, path: &str, now_ms: i64) -> Result<()> {
    let mut entries = load_mru_data(io);

    // Remove any existing entry for the same path (dedup by path).
    entries.retain(|e| e.path != path);

    // Newest first.
    entries.insert(
        0,
        MruEntry {
            branch: branch.to_string(),
            path: path.to_string(),
            timestamp: now_ms,
        },
    );

    if entries.len() > MAX_MRU_ENTRIES {
        entries.truncate(MAX_MRU_ENTRIES);
    }

    save_mru_data(io, &entries)
}

/// Update an entry's path+branch in place (used by `vibe rename`, Phase 3).
///
/// Finds the entry whose path equals `old_path` and rewrites both fields,
/// preserving its timestamp (and thus MRU position). No-op when nothing matches
/// or the entry already has the desired values.
pub fn update_mru_branch(
    io: &impl Io,
    old_path: &str,
    new_path: &str,
    new_branch: &str,
) -> Result<()> {
    let mut entries = load_mru_data(io);

    let Some(idx) = entries.iter().position(|e| e.path == old_path) else {
        return Ok(()); // Not found.
    };

    let no_change = entries[idx].path == new_path && entries[idx].branch == new_branch;
    if no_change {
        return Ok(());
    }

    entries[idx].path = new_path.to_string();
    entries[idx].branch = new_branch.to_string();

    save_mru_data(io, &entries)
}

/// Sort `matches` by MRU order (pure).
///
/// Entries present in `mru_entries` come first, ordered by timestamp descending
/// (most recent first); the rest follow in their original order. Ties between
/// equal timestamps preserve input order (stable sort), matching the TS, which
/// relied on `Array.prototype.sort` stability.
pub fn sort_by_mru<T: HasPath + Clone>(matches: &[T], mru_entries: &[MruEntry]) -> Vec<T> {
    let mut in_mru: Vec<(&T, i64)> = Vec::new();
    let mut not_in_mru: Vec<T> = Vec::new();

    for m in matches {
        let ts = mru_entries
            .iter()
            .find(|e| e.path == m.path())
            .map(|e| e.timestamp);
        match ts {
            Some(timestamp) => in_mru.push((m, timestamp)),
            None => not_in_mru.push(m.clone()),
        }
    }

    // Stable sort by timestamp descending.
    in_mru.sort_by(|a, b| b.1.cmp(&a.1));

    let mut out: Vec<T> = in_mru.into_iter().map(|(m, _)| m.clone()).collect();
    out.extend(not_in_mru);
    out
}

/// Trait giving `sort_by_mru` access to an item's path.
pub trait HasPath {
    fn path(&self) -> &str;
}

/// Save entries as pretty JSON + trailing newline via an atomic write.
fn save_mru_data(io: &impl Io, entries: &[MruEntry]) -> Result<()> {
    let home = io.home().filter(|h| !h.is_empty()).ok_or_else(|| {
        crate::error::VibeError::Configuration("HOME environment variable is not set".into())
    })?;
    config_path::ensure_config_dir(&home)?;
    let path = mru_file_path(&home)?;

    let mut content = serde_json::to_string_pretty(entries).map_err(|e| {
        crate::error::VibeError::Configuration(format!("Failed to serialize mru.json: {e}"))
    })?;
    content.push('\n');

    atomic_write(&path, content.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::FakeIo;
    use vibe_test_support::Fixture;

    #[derive(Debug, Clone, PartialEq)]
    struct Match {
        path: String,
        branch: String,
    }
    impl HasPath for Match {
        fn path(&self) -> &str {
            &self.path
        }
    }
    fn m(path: &str) -> Match {
        Match {
            path: path.into(),
            branch: "b".into(),
        }
    }

    fn io_for(home: &std::path::Path) -> FakeIo {
        FakeIo::new().with_env("HOME", home.to_str().unwrap())
    }

    #[test]
    fn load_missing_returns_empty() {
        let fx = Fixture::new();
        assert!(load_mru_data(&io_for(fx.path())).is_empty());
    }

    #[test]
    fn load_corrupt_returns_empty() {
        let fx = Fixture::new();
        let _ = fx.write(".config/vibe/mru.json", "{not an array");
        assert!(load_mru_data(&io_for(fx.path())).is_empty());
    }

    #[test]
    fn load_filters_malformed_entries() {
        let fx = Fixture::new();
        let _ = fx.write(
            ".config/vibe/mru.json",
            r#"[{"branch":"a","path":"/a","timestamp":1},{"branch":"bad"}]"#,
        );
        let entries = load_mru_data(&io_for(fx.path()));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "/a");
    }

    #[test]
    fn record_dedups_and_prepends() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        record_mru_entry(&io, "feat", "/wt/feat", 100).unwrap();
        record_mru_entry(&io, "main", "/wt/main", 200).unwrap();
        // Re-record /wt/feat: it moves to the front with a new timestamp.
        record_mru_entry(&io, "feat", "/wt/feat", 300).unwrap();

        let entries = load_mru_data(&io);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "/wt/feat");
        assert_eq!(entries[0].timestamp, 300);
        assert_eq!(entries[1].path, "/wt/main");
    }

    #[test]
    fn record_caps_at_max() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        for i in 0..(MAX_MRU_ENTRIES + 10) {
            record_mru_entry(&io, "b", &format!("/wt/{i}"), i as i64).unwrap();
        }
        let entries = load_mru_data(&io);
        assert_eq!(entries.len(), MAX_MRU_ENTRIES);
        // Newest path is first.
        assert_eq!(entries[0].path, format!("/wt/{}", MAX_MRU_ENTRIES + 9));
    }

    #[test]
    fn sort_by_mru_orders_recent_first_then_original() {
        let mru = vec![
            MruEntry {
                branch: "b".into(),
                path: "/b".into(),
                timestamp: 100,
            },
            MruEntry {
                branch: "d".into(),
                path: "/d".into(),
                timestamp: 300,
            },
        ];
        // input order: a, b, c, d  (a,c not in MRU; b ts=100, d ts=300)
        let matches = vec![m("/a"), m("/b"), m("/c"), m("/d")];
        let sorted = sort_by_mru(&matches, &mru);
        let paths: Vec<&str> = sorted.iter().map(|x| x.path.as_str()).collect();
        // MRU first by ts desc: /d, /b; then non-MRU in original order: /a, /c.
        assert_eq!(paths, vec!["/d", "/b", "/a", "/c"]);
    }

    #[test]
    fn update_mru_branch_rewrites_and_keeps_timestamp() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        record_mru_entry(&io, "old", "/wt/old", 500).unwrap();
        update_mru_branch(&io, "/wt/old", "/wt/new", "new").unwrap();
        let entries = load_mru_data(&io);
        assert_eq!(entries[0].path, "/wt/new");
        assert_eq!(entries[0].branch, "new");
        assert_eq!(entries[0].timestamp, 500);
    }

    #[test]
    fn update_mru_branch_noop_when_absent() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        record_mru_entry(&io, "a", "/wt/a", 1).unwrap();
        update_mru_branch(&io, "/nope", "/x", "x").unwrap();
        let entries = load_mru_data(&io);
        assert_eq!(entries[0].path, "/wt/a");
    }
}
