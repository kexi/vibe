//! User settings & the SHA-256 trust store (`~/.config/vibe/settings.json`).
//!
//! Ported from `packages/core/src/utils/settings.ts`. This is the most
//! security-sensitive port: it holds the legacy→v1→v2→v3 migration ladder and
//! the repository-based trust matching that decides whether a `.vibe.toml` is
//! executed. A wrong port could silently un-trust users or accept a stale hash,
//! so the schema shapes, migration transforms, FIFO hash history and matching
//! rules are reproduced exactly and unit-tested against the same scenarios as
//! the TS suite.
//!
//! Migrations need two side-effectful inputs the TS got from `AppContext`:
//! hashing a file (v1→v2) and resolving repo info from a path (v2→v3). These are
//! injected via the [`RepoResolver`] trait so the transforms stay testable
//! without a real filesystem or git.

use crate::git::RepoInfo;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Current on-disk schema version.
pub const CURRENT_SCHEMA_VERSION: u32 = 3;

/// Max hashes kept per entry (FIFO eviction beyond this).
pub const MAX_HASH_HISTORY: usize = 100;

/// A repository identity: a normalized remote URL and/or the repo root path.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RepoId {
    #[serde(rename = "remoteUrl", skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    #[serde(rename = "repoRoot", skip_serializing_if = "Option::is_none")]
    pub repo_root: Option<String>,
}

/// A v3 allow-list entry: a trusted config file, identified by repo + relative
/// path, with a history of accepted content hashes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AllowEntry {
    #[serde(rename = "repoId")]
    pub repo_id: RepoId,
    #[serde(rename = "relativePath")]
    pub relative_path: String,
    pub hashes: Vec<String>,
    #[serde(rename = "skipHashCheck", skip_serializing_if = "Option::is_none")]
    pub skip_hash_check: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Permissions {
    pub allow: Vec<AllowEntry>,
    pub deny: Vec<String>,
}

/// The v3 `worktree` settings section.
///
/// Modeled as a typed field (rather than left in [`VibeSettings::extra`]) so the
/// worktree-path resolver can read `settings.worktree.path_script` directly. The
/// JSON key is `path_script` (snake_case) to match the existing on-disk fixtures
/// and the TS `SettingsSchemaV3` (`worktree: { path_script }`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SettingsWorktree {
    #[serde(rename = "path_script", skip_serializing_if = "Option::is_none")]
    pub path_script: Option<String>,
}

/// The v3 settings document.
///
/// The TS v3 schema (`SettingsSchemaV3`) also allows top-level `worktree`
/// (`{ path_script }`), `clean` (`{ fast_remove }`) and `$schema` keys that this
/// Rust port does not yet model as typed fields. Rather than drop them on
/// load→save (which would PERMANENTLY LOSE a user's hand-edited `worktree`/
/// `clean` settings the first time the Rust build runs `trust`/`untrust` during
/// the TS↔Rust coexistence period), every unmodeled top-level key is captured in
/// [`VibeSettings::extra`] via `#[serde(flatten)]` so it round-trips byte-for-byte.
/// `$schema` is re-emitted first by `save_user_settings`, so even if it lands in
/// `extra` it is not double-written (see `with_schema_first`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VibeSettings {
    pub version: u32,
    #[serde(rename = "skipHashCheck", skip_serializing_if = "Option::is_none")]
    pub skip_hash_check: Option<bool>,
    /// The typed `worktree` section (`{ path_script }`). Modeled (not in `extra`)
    /// so the worktree-path resolver can read it directly. Omitted from JSON when
    /// `None` so settings without a worktree section round-trip byte-for-byte.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<SettingsWorktree>,
    pub permissions: Permissions,
    /// Any remaining top-level keys not modeled above (e.g. `clean`, `$schema`),
    /// preserved verbatim so a load→save cycle never drops them.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl VibeSettings {
    /// Fresh empty settings at the current schema version.
    pub fn default_settings() -> Self {
        VibeSettings {
            version: CURRENT_SCHEMA_VERSION,
            skip_hash_check: Some(false),
            worktree: None,
            permissions: Permissions::default(),
            extra: serde_json::Map::new(),
        }
    }
}

/// Resolves a path to its repository info and hashes files. Abstracts the
/// `getRepoInfoFromPath` / `calculateFileHash` calls the TS migrations made
/// through `AppContext`, so migration shape transforms are unit-testable.
pub trait RepoResolver {
    /// Repository info for an absolute path, or `None` if not in a git repo.
    fn repo_info(&self, path: &str) -> Option<RepoInfo>;
    /// SHA-256 hex of the file at `path`, or `Err` if unreadable.
    fn hash_file(&self, path: &str) -> Result<String, String>;
}

/// Read the `version` field; `0` means legacy (no version), matching the TS.
pub fn get_schema_version(data: &Value) -> u32 {
    data.get("version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(0)
}

/// Run the migration ladder up to [`CURRENT_SCHEMA_VERSION`].
///
/// Mirrors `migrateSettings`: repeatedly apply the migration for the current
/// version until reaching v3. Returns the migrated JSON value.
pub fn migrate_settings(data: Value, resolver: &impl RepoResolver) -> Result<Value, String> {
    let mut current = data;
    let mut version = get_schema_version(&current);

    while version < CURRENT_SCHEMA_VERSION {
        current = match version {
            0 => migrate_legacy_to_v1(current),
            1 => migrate_v1_to_v2(current, resolver),
            2 => migrate_v2_to_v3(current, resolver),
            other => return Err(format!("Migration from version {other} is not defined")),
        };
        let next = get_schema_version(&current);
        // Guard against a migration that fails to advance the version (the TS
        // returns data as-is on parse failure, which would loop forever).
        if next <= version && next < CURRENT_SCHEMA_VERSION {
            return Err(format!("Migration from version {version} did not advance"));
        }
        version = next;
    }

    Ok(current)
}

/// legacy (no version) → v1: just stamp `version: 1`, keeping permissions.
fn migrate_legacy_to_v1(data: Value) -> Value {
    let Some(permissions) = data.get("permissions").cloned() else {
        return data; // Not legacy-shaped; leave as-is (TS behavior).
    };
    serde_json::json!({ "version": 1, "permissions": permissions })
}

/// v1 → v2: attach a content hash to each allow path. A path whose hash can't
/// be computed is kept with `skipHashCheck: true` rather than dropped.
fn migrate_v1_to_v2(data: Value, resolver: &impl RepoResolver) -> Value {
    let Some(allow) = data
        .get("permissions")
        .and_then(|p| p.get("allow"))
        .and_then(Value::as_array)
    else {
        return data;
    };
    let deny = data
        .get("permissions")
        .and_then(|p| p.get("deny"))
        .cloned()
        .unwrap_or_else(|| Value::Array(vec![]));

    let allow_with_hashes: Vec<Value> = allow
        .iter()
        .filter_map(|p| p.as_str())
        .map(|path| match resolver.hash_file(path) {
            Ok(hash) => serde_json::json!({ "path": path, "hashes": [hash] }),
            Err(_) => {
                serde_json::json!({ "path": path, "hashes": [], "skipHashCheck": true })
            }
        })
        .collect();

    serde_json::json!({
        "version": 2,
        "skipHashCheck": false,
        "permissions": { "allow": allow_with_hashes, "deny": deny },
    })
}

/// v2 → v3: convert each path-based entry to repository-based, using the
/// resolver. Paths not in a git repo fall back to `dirname`/`basename`.
fn migrate_v2_to_v3(data: Value, resolver: &impl RepoResolver) -> Value {
    let Some(allow) = data
        .get("permissions")
        .and_then(|p| p.get("allow"))
        .and_then(Value::as_array)
    else {
        return data;
    };
    let deny = data
        .get("permissions")
        .and_then(|p| p.get("deny"))
        .cloned()
        .unwrap_or_else(|| Value::Array(vec![]));
    let skip_hash_check = data.get("skipHashCheck").cloned().unwrap_or(Value::Null);

    let allow_v3: Vec<Value> = allow
        .iter()
        .map(|entry| {
            let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
            let hashes = entry.get("hashes").cloned().unwrap_or(Value::Array(vec![]));
            let entry_skip = entry.get("skipHashCheck").cloned();

            match resolver.repo_info(path) {
                Some(info) => {
                    let mut repo_id = serde_json::Map::new();
                    if let Some(url) = info.remote_url {
                        repo_id.insert("remoteUrl".into(), Value::String(url));
                    }
                    repo_id.insert("repoRoot".into(), Value::String(info.repo_root));
                    let mut obj = serde_json::Map::new();
                    obj.insert("repoId".into(), Value::Object(repo_id));
                    obj.insert("relativePath".into(), Value::String(info.relative_path));
                    obj.insert("hashes".into(), hashes);
                    if let Some(s) = entry_skip {
                        obj.insert("skipHashCheck".into(), s);
                    }
                    Value::Object(obj)
                }
                None => {
                    // Fallback: directory as repoRoot, filename as relativePath.
                    let (dir, base) = dirname_basename(path);
                    serde_json::json!({
                        "repoId": { "repoRoot": dir },
                        "relativePath": base,
                        "hashes": hashes,
                        "skipHashCheck": entry_skip,
                    })
                }
            }
        })
        .collect();

    let mut out = serde_json::Map::new();
    out.insert("version".into(), Value::from(3));
    out.insert("skipHashCheck".into(), skip_hash_check);
    out.insert(
        "permissions".into(),
        serde_json::json!({ "allow": allow_v3, "deny": deny }),
    );
    Value::Object(out)
}

/// Split a path into (dirname, basename), matching node's `path.dirname` /
/// `path.basename` closely enough for the fallback case.
fn dirname_basename(path: &str) -> (String, String) {
    let p = std::path::Path::new(path);
    let dir = p
        .parent()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());
    let base = p
        .file_name()
        .map(|b| b.to_string_lossy().to_string())
        .unwrap_or_default();
    (dir, base)
}

/// Find the allow entry matching `repo_info`, by the v3 rules:
/// relative path must match, then prefer remote-URL equality, else repo-root.
pub fn find_matching_entry<'a>(
    allow: &'a [AllowEntry],
    repo_info: &RepoInfo,
) -> Option<&'a AllowEntry> {
    allow.iter().find(|entry| {
        if entry.relative_path != repo_info.relative_path {
            return false;
        }
        // Priority 1: remote URL (only when both have it).
        if let (Some(a), Some(b)) = (&entry.repo_id.remote_url, &repo_info.remote_url) {
            return a == b;
        }
        // Priority 2: repo root. `repo_info.repo_root` is always present; the
        // TS guard `entry.repoId.repoRoot && repoInfo.repoRoot` reduces to
        // "the entry has a repo_root and it equals repo_info's".
        if let Some(a) = &entry.repo_id.repo_root {
            return a == &repo_info.repo_root;
        }
        false
    })
}

/// Add `hash` to an entry's history with dedup + FIFO eviction. Returns `true`
/// if the history changed.
pub fn push_hash_fifo(hashes: &mut Vec<String>, hash: String) -> bool {
    if hashes.contains(&hash) {
        return false;
    }
    hashes.push(hash);
    if hashes.len() > MAX_HASH_HISTORY {
        hashes.remove(0); // Drop the oldest (FIFO).
    }
    true
}

/// Whether to skip hash verification for an entry: per-entry overrides global,
/// default `false`. Matches the TS `entry.skipHashCheck ?? settings.skipHashCheck ?? false`.
pub fn should_skip_hash_check(entry: &AllowEntry, settings: &VibeSettings) -> bool {
    entry
        .skip_hash_check
        .or(settings.skip_hash_check)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Resolver backed by in-memory maps, mirroring the TS mocks.
    struct MockResolver {
        repos: HashMap<String, RepoInfo>,
        hashes: HashMap<String, String>,
    }
    impl RepoResolver for MockResolver {
        fn repo_info(&self, path: &str) -> Option<RepoInfo> {
            self.repos.get(path).cloned()
        }
        fn hash_file(&self, path: &str) -> Result<String, String> {
            self.hashes
                .get(path)
                .cloned()
                .ok_or_else(|| format!("no hash for {path}"))
        }
    }

    fn entry(repo_root: &str, rel: &str, hashes: &[&str]) -> AllowEntry {
        AllowEntry {
            repo_id: RepoId {
                remote_url: None,
                repo_root: Some(repo_root.into()),
            },
            relative_path: rel.into(),
            hashes: hashes.iter().map(|s| s.to_string()).collect(),
            skip_hash_check: None,
        }
    }

    #[test]
    fn schema_version_zero_for_legacy() {
        let legacy = serde_json::json!({ "permissions": { "allow": [], "deny": [] } });
        assert_eq!(get_schema_version(&legacy), 0);
    }

    #[test]
    fn schema_version_reads_field() {
        assert_eq!(get_schema_version(&serde_json::json!({ "version": 2 })), 2);
        assert_eq!(get_schema_version(&serde_json::json!({ "version": 3 })), 3);
    }

    #[test]
    fn default_settings_at_current_version() {
        let s = VibeSettings::default_settings();
        assert_eq!(s.version, CURRENT_SCHEMA_VERSION);
        assert!(s.permissions.allow.is_empty());
    }

    #[test]
    fn migrates_v1_to_v3_with_repo_info() {
        // v1 settings with one absolute path; resolver knows its hash + repo.
        let path = "/repo/.vibe.toml";
        let mut hashes = HashMap::new();
        hashes.insert(path.to_string(), "deadbeef".to_string());
        let mut repos = HashMap::new();
        repos.insert(
            path.to_string(),
            RepoInfo {
                remote_url: Some("github.com/u/r".into()),
                repo_root: "/repo".into(),
                relative_path: ".vibe.toml".into(),
            },
        );
        let resolver = MockResolver { repos, hashes };

        let v1 = serde_json::json!({
            "version": 1,
            "permissions": { "allow": [path], "deny": [] },
        });
        let migrated = migrate_settings(v1, &resolver).unwrap();
        let settings: VibeSettings = serde_json::from_value(migrated).unwrap();

        assert_eq!(settings.version, 3);
        assert_eq!(settings.permissions.allow.len(), 1);
        let e = &settings.permissions.allow[0];
        assert_eq!(e.relative_path, ".vibe.toml");
        assert_eq!(e.repo_id.remote_url.as_deref(), Some("github.com/u/r"));
        assert_eq!(e.repo_id.repo_root.as_deref(), Some("/repo"));
        assert_eq!(e.hashes, vec!["deadbeef".to_string()]);
    }

    #[test]
    fn migrates_legacy_to_v3() {
        let path = "/repo/.vibe.toml";
        let mut hashes = HashMap::new();
        hashes.insert(path.to_string(), "abc".to_string());
        let mut repos = HashMap::new();
        repos.insert(
            path.to_string(),
            RepoInfo {
                remote_url: None,
                repo_root: "/repo".into(),
                relative_path: ".vibe.toml".into(),
            },
        );
        let resolver = MockResolver { repos, hashes };

        let legacy = serde_json::json!({ "permissions": { "allow": [path], "deny": [] } });
        let migrated = migrate_settings(legacy, &resolver).unwrap();
        let settings: VibeSettings = serde_json::from_value(migrated).unwrap();
        assert_eq!(settings.version, 3);
        assert_eq!(
            settings.permissions.allow[0].hashes,
            vec!["abc".to_string()]
        );
    }

    #[test]
    fn v1_to_v2_keeps_unhashable_path_with_skip() {
        // No hash entry → migration keeps the path with skipHashCheck=true.
        let path = "/gone/.vibe.toml";
        let resolver = MockResolver {
            repos: HashMap::new(),
            hashes: HashMap::new(),
        };
        let v2 = migrate_v1_to_v2(
            serde_json::json!({
                "version": 1,
                "permissions": { "allow": [path], "deny": [] },
            }),
            &resolver,
        );
        let allow = v2["permissions"]["allow"].as_array().unwrap();
        assert_eq!(allow[0]["skipHashCheck"], serde_json::json!(true));
        assert_eq!(allow[0]["hashes"], serde_json::json!([]));
    }

    #[test]
    fn v2_to_v3_falls_back_to_dirname_basename_outside_repo() {
        let resolver = MockResolver {
            repos: HashMap::new(),
            hashes: HashMap::new(),
        };
        let v3 = migrate_v2_to_v3(
            serde_json::json!({
                "version": 2,
                "skipHashCheck": false,
                "permissions": {
                    "allow": [{ "path": "/x/y/.vibe.toml", "hashes": ["h"] }],
                    "deny": [],
                },
            }),
            &resolver,
        );
        let e = &v3["permissions"]["allow"][0];
        assert_eq!(e["repoId"]["repoRoot"], serde_json::json!("/x/y"));
        assert_eq!(e["relativePath"], serde_json::json!(".vibe.toml"));
        assert_eq!(e["hashes"], serde_json::json!(["h"]));
    }

    #[test]
    fn find_matching_entry_by_repo_root() {
        let allow = vec![entry("/repo", ".vibe.toml", &["h1"])];
        let info = RepoInfo {
            remote_url: None,
            repo_root: "/repo".into(),
            relative_path: ".vibe.toml".into(),
        };
        assert!(find_matching_entry(&allow, &info).is_some());
    }

    #[test]
    fn find_matching_entry_prefers_remote_url() {
        let allow = vec![AllowEntry {
            repo_id: RepoId {
                remote_url: Some("github.com/u/r".into()),
                repo_root: Some("/wrong".into()),
            },
            relative_path: ".vibe.toml".into(),
            hashes: vec![],
            skip_hash_check: None,
        }];
        // remote_url matches even though repo_root differs.
        let info = RepoInfo {
            remote_url: Some("github.com/u/r".into()),
            repo_root: "/elsewhere".into(),
            relative_path: ".vibe.toml".into(),
        };
        assert!(find_matching_entry(&allow, &info).is_some());

        // remote_url mismatch → no match (does not fall through to repo_root).
        let info2 = RepoInfo {
            remote_url: Some("github.com/u/other".into()),
            repo_root: "/wrong".into(),
            relative_path: ".vibe.toml".into(),
        };
        assert!(find_matching_entry(&allow, &info2).is_none());
    }

    #[test]
    fn find_matching_entry_requires_relative_path() {
        let allow = vec![entry("/repo", ".vibe.toml", &[])];
        let info = RepoInfo {
            remote_url: None,
            repo_root: "/repo".into(),
            relative_path: ".vibe.local.toml".into(),
        };
        assert!(find_matching_entry(&allow, &info).is_none());
    }

    #[test]
    fn push_hash_dedups() {
        let mut hashes = vec!["a".to_string()];
        assert!(!push_hash_fifo(&mut hashes, "a".to_string()));
        assert_eq!(hashes, vec!["a".to_string()]);
        assert!(push_hash_fifo(&mut hashes, "b".to_string()));
        assert_eq!(hashes, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn push_hash_fifo_evicts_oldest() {
        let mut hashes: Vec<String> = (0..MAX_HASH_HISTORY).map(|i| format!("h{i}")).collect();
        assert!(push_hash_fifo(&mut hashes, "new".to_string()));
        assert_eq!(hashes.len(), MAX_HASH_HISTORY);
        assert_eq!(hashes[0], "h1"); // h0 evicted
        assert_eq!(hashes[MAX_HASH_HISTORY - 1], "new");
    }

    #[test]
    fn skip_hash_check_precedence() {
        let mut e = entry("/repo", ".vibe.toml", &[]);
        let mut s = VibeSettings::default_settings();

        // default false
        s.skip_hash_check = None;
        assert!(!should_skip_hash_check(&e, &s));

        // global true
        s.skip_hash_check = Some(true);
        assert!(should_skip_hash_check(&e, &s));

        // per-entry false overrides global true
        e.skip_hash_check = Some(false);
        assert!(!should_skip_hash_check(&e, &s));
    }

    #[test]
    fn round_trips_v3_json_field_names() {
        // Ensure serde field renames match the on-disk camelCase shape.
        let s = VibeSettings {
            version: 3,
            skip_hash_check: Some(false),
            worktree: None,
            permissions: Permissions {
                allow: vec![entry("/repo", ".vibe.toml", &["h"])],
                deny: vec![],
            },
            extra: serde_json::Map::new(),
        };
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["version"], serde_json::json!(3));
        assert_eq!(json["skipHashCheck"], serde_json::json!(false));
        assert_eq!(
            json["permissions"]["allow"][0]["relativePath"],
            serde_json::json!(".vibe.toml")
        );
        assert_eq!(
            json["permissions"]["allow"][0]["repoId"]["repoRoot"],
            serde_json::json!("/repo")
        );
        // Round-trips back.
        let back: VibeSettings = serde_json::from_value(json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn preserves_unknown_top_level_keys_through_round_trip() {
        // A settings document with the now-typed `worktree` key, the still-
        // unmodeled `clean` key, plus a wholly unknown future key. None of these
        // must be dropped on load→serialize (the Phase 3 data-loss keystone).
        // `worktree` now binds to the TYPED field (Phase 3, point 6); `clean` and
        // unknown keys still flow through `extra`.
        let raw = serde_json::json!({
            "version": 3,
            "skipHashCheck": false,
            "worktree": { "path_script": "echo /tmp/wt" },
            "clean": { "fast_remove": true },
            "futureKey": { "nested": [1, 2, 3] },
            "permissions": { "allow": [], "deny": [] },
        });

        let settings: VibeSettings = serde_json::from_value(raw).unwrap();
        // `worktree` is now captured by the typed field, NOT `extra`.
        assert_eq!(
            settings
                .worktree
                .as_ref()
                .and_then(|w| w.path_script.as_deref()),
            Some("echo /tmp/wt")
        );
        assert!(settings.extra.get("worktree").is_none());
        // The remaining unmodeled keys still land in `extra`, not discarded.
        assert_eq!(
            settings.extra.get("clean"),
            Some(&serde_json::json!({ "fast_remove": true }))
        );
        assert_eq!(
            settings.extra.get("futureKey"),
            Some(&serde_json::json!({ "nested": [1, 2, 3] }))
        );

        // Serializing back reproduces every key verbatim — the key-survival
        // keystone holds regardless of which field backs `worktree`.
        let back = serde_json::to_value(&settings).unwrap();
        assert_eq!(
            back["worktree"],
            serde_json::json!({ "path_script": "echo /tmp/wt" })
        );
        assert_eq!(back["clean"], serde_json::json!({ "fast_remove": true }));
        assert_eq!(
            back["futureKey"],
            serde_json::json!({ "nested": [1, 2, 3] })
        );
        assert_eq!(back["version"], serde_json::json!(3));
        assert_eq!(back["skipHashCheck"], serde_json::json!(false));
    }

    #[test]
    fn schema_key_round_trips_through_extra() {
        // `$schema` is not a typed field; it must survive in `extra` so the save
        // path can re-emit it first without losing the value.
        let raw = serde_json::json!({
            "$schema": "https://example/v1/settings.schema.json",
            "version": 3,
            "permissions": { "allow": [], "deny": [] },
        });
        let settings: VibeSettings = serde_json::from_value(raw).unwrap();
        assert_eq!(
            settings.extra.get("$schema").and_then(Value::as_str),
            Some("https://example/v1/settings.schema.json")
        );
    }
}
