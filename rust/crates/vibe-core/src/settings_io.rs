//! Load/save `settings.json` and the TOCTOU-safe trust verification.
//!
//! Ported from the file-IO half of `packages/core/src/utils/settings.ts`. The
//! pure schema/migration/matching logic lives in `settings.rs` (Phase 1); this
//! module wires it to the filesystem through the injected [`Io`] and a
//! [`RepoResolver`], and implements the security-hardened atomic write.

use crate::atomic::atomic_write;
use crate::error::{Result, VibeError};
use crate::hash::hash_content;
use crate::io::Io;
use crate::settings::{
    find_matching_entry, get_schema_version, migrate_settings, push_hash_fifo,
    should_skip_hash_check, AllowEntry, RepoId, RepoResolver, VibeSettings, CURRENT_SCHEMA_VERSION,
};
use crate::{config_path, output};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// `$HOME/.config/vibe/settings.json`.
pub fn get_settings_path(home: &str) -> Result<PathBuf> {
    Ok(config_path::config_dir(home)?.join("settings.json"))
}

/// The version-tagged JSON Schema URL injected as `$schema`.
///
/// `version` is the binary's build version (e.g. `1.8.1+abc`); the suffix after
/// `+` is dropped to get the semver, matching the TS `getSettingsSchemaUrl`.
fn settings_schema_url(version: &str) -> String {
    let semver = version.split('+').next().unwrap_or(version);
    format!("https://raw.githubusercontent.com/kexi/vibe/v{semver}/schemas/settings.schema.json")
}

/// Load user settings, running the migration ladder and persisting an upgrade.
///
/// - file missing → default settings (TS `isNotFound`)
/// - JSON parse error → propagated (TS rethrows)
/// - schema-validation failure after migration → warn + default settings
/// - migration advanced the version → write the upgraded file back
///
/// `version` is the binary's build version, used only when a migration triggers
/// a save (for the `$schema` URL).
pub fn load_user_settings(
    io: &impl Io,
    resolver: &impl RepoResolver,
    version: &str,
) -> Result<VibeSettings> {
    let home = require_home(io)?;
    let path = get_settings_path(&home)?;

    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(VibeSettings::default_settings());
        }
        Err(e) => {
            return Err(VibeError::FileSystem(format!(
                "Failed to read {}: {e}",
                path.display()
            )));
        }
    };

    let raw: Value = serde_json::from_str(&content)
        .map_err(|e| VibeError::Configuration(format!("Failed to parse settings.json: {e}")))?;

    let original_version = get_schema_version(&raw);
    let migrated = migrate_settings(raw, resolver).map_err(VibeError::Configuration)?;

    // Schema validation = deserialization into the typed struct.
    let settings: VibeSettings = match serde_json::from_value(migrated) {
        Ok(s) => s,
        Err(e) => {
            output::warn_log(
                io,
                &format!("Settings validation failed, using defaults: {e}"),
            );
            return Ok(VibeSettings::default_settings());
        }
    };

    let needs_persist = original_version != CURRENT_SCHEMA_VERSION;
    if needs_persist {
        save_user_settings(io, &settings, version)?;
    }

    Ok(settings)
}

/// Save user settings atomically with a 0600 file, injecting `$schema` first.
///
/// Pretty JSON + trailing newline, matching the TS on-disk shape. `$schema` is
/// emitted as the first key with the freshly-computed (version-tagged) URL, even
/// if the loaded settings carried an old `$schema` through
/// [`VibeSettings::extra`] — [`with_schema_first`] drops any existing `$schema`
/// from the body so it is written exactly once and never stale. See
/// [`crate::atomic::atomic_write`] for the write strategy.
pub fn save_user_settings(io: &impl Io, settings: &VibeSettings, version: &str) -> Result<()> {
    let home = require_home(io)?;
    config_path::ensure_config_dir(&home)?;
    let path = get_settings_path(&home)?;

    // Build the document with `$schema` as the first key. serde structs cannot
    // express "$schema first" without a wrapper, so serialize to a Value, then
    // re-key into an ordered map.
    let body = serde_json::to_value(settings)
        .map_err(|e| VibeError::Configuration(format!("Failed to serialize settings: {e}")))?;
    let document = with_schema_first(&settings_schema_url(version), body);

    let mut content = serde_json::to_string_pretty(&document)
        .map_err(|e| VibeError::Configuration(format!("Failed to serialize settings: {e}")))?;
    content.push('\n');

    atomic_write(&path, content.as_bytes())
}

/// Verify trust and return the exact content that was hashed (TOCTOU-safe).
///
/// Returns `(trusted, content)`. When trusted, `content` is the bytes the trust
/// decision was made on. Callers MUST use this returned content and never
/// re-open the file: re-reading would reintroduce a time-of-check/time-of-use
/// race where an attacker swaps the file between verification and use.
///
/// Mirrors `verifyTrustAndRead`: not in a repo → `(false, None)`; no matching
/// allow entry → `(false, None)`; skip-hash-check → `(true, Some(content))`
/// with a warning; hash match → `(true, Some(content))`; mismatch →
/// `(false, None)`.
pub fn verify_trust_and_read(
    io: &impl Io,
    resolver: &impl RepoResolver,
    version: &str,
    vibe_file_path: &str,
) -> Result<(bool, Option<String>)> {
    let settings = load_user_settings(io, resolver, version)?;

    let Some(repo_info) = resolver.repo_info(vibe_file_path) else {
        return Ok((false, None)); // Not in a git repository.
    };

    let Some(entry) = find_matching_entry(&settings.permissions.allow, &repo_info) else {
        return Ok((false, None));
    };

    // Read the file exactly once; all decisions use this content.
    let content = std::fs::read_to_string(vibe_file_path)
        .map_err(|e| VibeError::FileSystem(format!("Failed to read {vibe_file_path}: {e}")))?;

    let skip = should_skip_hash_check(entry, &settings);
    if skip {
        output::warn_log(
            io,
            &format!("Warning: Hash verification is disabled for {vibe_file_path}"),
        );
        return Ok((true, Some(content)));
    }

    let file_hash = hash_content(content.as_bytes());
    let hash_matches = entry.hashes.contains(&file_hash);
    if hash_matches {
        return Ok((true, Some(content)));
    }

    Ok((false, None))
}

/// Trust a config file: record (or extend) its allow-list entry.
///
/// Ported from `addTrustedPath`. Validates the path is absolute, resolves its
/// repository, hashes its content, then either appends the hash to a matching
/// entry (dedup + FIFO ≤100) or pushes a new repository-based entry, and saves.
///
/// SECURITY (Phase 3, point 6): the TS computed the stored identity and the
/// stored hash from two *different* views of the path. `getRepoInfoFromPath`
/// resolves symlinks (`realPath`) before deriving repoRoot/relativePath, while
/// `calculateFileHash` reads the *raw* `path`. For a symlinked config these
/// disagree: the entry is keyed by the resolved repo identity but its hash is
/// taken through the symlink. Here we canonicalize ONCE and drive BOTH the
/// repo-info lookup AND the hash from that single real path, so the stored
/// identity and stored hash always describe the same bytes. In the symlink-free
/// normal case `canonicalize(path) == path`, so parity with the TS is preserved;
/// only the symlinked-registration edge changes (the fix). If canonicalization
/// fails (path missing / unreadable), we surface the same not-in-git-repo error
/// the TS would reach (repo_info would be `None` anyway).
///
/// Note: `verify_trust_and_read` reads the candidate file via the path the
/// loader passes it (joined under repo_root, not separately canonicalized), so
/// trust still verifies correctly for the normal non-symlink case this fix
/// targets.
pub fn add_trusted_path(
    io: &impl Io,
    resolver: &impl RepoResolver,
    version: &str,
    path: &str,
) -> Result<()> {
    let is_absolute = Path::new(path).is_absolute();
    if !is_absolute {
        return Err(VibeError::Configuration(format!(
            "Path must be absolute: {path}\nRelative paths are not supported for security reasons."
        )));
    }

    let mut settings = load_user_settings(io, resolver, version)?;

    // Canonicalize ONCE; the same real path drives both repo_info and hashing.
    let real_path = match std::fs::canonicalize(path) {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(_) => {
            // A path we cannot resolve cannot be in a git repo; mirror the TS
            // not-in-repo error rather than leaking the raw io error.
            return Err(not_in_repo_error(path));
        }
    };

    let Some(repo_info) = resolver.repo_info(&real_path) else {
        return Err(not_in_repo_error(path));
    };

    let hash = resolver
        .hash_file(&real_path)
        .map_err(VibeError::FileSystem)?;

    match find_matching_entry_mut(&mut settings.permissions.allow, &repo_info) {
        Some(entry) => {
            // Dedup + FIFO ≤ MAX_HASH_HISTORY; no-op if the hash is already known.
            push_hash_fifo(&mut entry.hashes, hash);
        }
        None => {
            settings.permissions.allow.push(AllowEntry {
                repo_id: RepoId {
                    remote_url: repo_info.remote_url.clone(),
                    repo_root: Some(repo_info.repo_root.clone()),
                },
                relative_path: repo_info.relative_path.clone(),
                hashes: vec![hash],
                skip_hash_check: None,
            });
        }
    }

    save_user_settings(io, &settings, version)
}

/// Untrust a config file: remove its allow-list entry, if present.
///
/// Ported from `removeTrustedPath`. Resolves the path's repository; if it cannot
/// be determined, warns and returns `Ok` (best-effort, matching the TS). Finds
/// the matching entry by (relative path equal) AND (remote URL both-present-and-
/// equal OR repo root entry-present-and-equal), removes it, and saves.
///
/// Note: unlike `add_trusted_path`, the TS `removeTrustedPath` passed the raw
/// `path` to `getRepoInfoFromPath` (which canonicalizes internally). We keep that
/// behavior — the resolver canonicalizes, so removal still matches a real entry.
pub fn remove_trusted_path(
    io: &impl Io,
    resolver: &impl RepoResolver,
    version: &str,
    path: &str,
) -> Result<()> {
    let mut settings = load_user_settings(io, resolver, version)?;

    let Some(repo_info) = resolver.repo_info(path) else {
        output::warn_log(
            io,
            &format!(
                "Warning: Cannot determine repository for {path}. Removal may not work correctly."
            ),
        );
        return Ok(());
    };

    let position = settings.permissions.allow.iter().position(|entry| {
        if entry.relative_path != repo_info.relative_path {
            return false;
        }
        let remote_match = matches!(
            (&entry.repo_id.remote_url, &repo_info.remote_url),
            (Some(a), Some(b)) if a == b
        );
        let root_match = matches!(
            (&entry.repo_id.repo_root, Some(&repo_info.repo_root)),
            (Some(a), Some(b)) if a == b
        );
        remote_match || root_match
    });

    if let Some(idx) = position {
        settings.permissions.allow.remove(idx);
    }

    save_user_settings(io, &settings, version)
}

/// Mutable counterpart of `find_matching_entry`: same v3 matching rules, but
/// returns a mutable reference so a matched entry's hash history can be extended.
fn find_matching_entry_mut<'a>(
    allow: &'a mut [AllowEntry],
    repo_info: &crate::git::RepoInfo,
) -> Option<&'a mut AllowEntry> {
    allow.iter_mut().find(|entry| {
        if entry.relative_path != repo_info.relative_path {
            return false;
        }
        if let (Some(a), Some(b)) = (&entry.repo_id.remote_url, &repo_info.remote_url) {
            return a == b;
        }
        if let Some(a) = &entry.repo_id.repo_root {
            return a == &repo_info.repo_root;
        }
        false
    })
}

/// The "cannot trust file outside of git repository" error (TS parity).
fn not_in_repo_error(path: &str) -> VibeError {
    VibeError::Configuration(format!(
        "Cannot trust file outside of git repository: {path}\nVibe requires configuration files to be within a git repository."
    ))
}

/// Require `$HOME`, erroring with a clear message if unset.
fn require_home(io: &impl Io) -> Result<String> {
    io.home()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| VibeError::Configuration("HOME environment variable is not set".to_string()))
}

/// Re-key a settings JSON object so `$schema` is the first entry.
///
/// Any pre-existing `$schema` carried in the body (e.g. round-tripped through
/// [`VibeSettings::extra`]) is skipped so `$schema` is emitted exactly once, with
/// the caller-supplied (fresh, version-tagged) URL, and never duplicated/stale.
fn with_schema_first(schema_url: &str, body: Value) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("$schema".to_string(), Value::String(schema_url.to_string()));
    if let Value::Object(obj) = body {
        for (k, v) in obj {
            if k == "$schema" {
                continue; // Already inserted first with the fresh URL.
            }
            map.insert(k, v);
        }
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::RepoInfo;
    use crate::io::FakeIo;
    use crate::settings::{AllowEntry, Permissions, RepoId};
    use std::collections::HashMap;
    use std::path::Path;
    use vibe_test_support::Fixture;

    const V: &str = "1.8.1+abc";

    /// Resolver backed by in-memory repo map + a real on-disk file hasher.
    ///
    /// Mirrors `RealRepoResolver`'s split: `repo_info` from a fixed map (keyed by
    /// the CANONICAL path, since `add_trusted_path` canonicalizes first), and
    /// `hash_file` reading the real file (so the unified-path security fix is
    /// exercised against actual bytes).
    #[derive(Default)]
    struct HashingResolver {
        repos: HashMap<String, RepoInfo>,
    }
    impl RepoResolver for HashingResolver {
        fn repo_info(&self, path: &str) -> Option<RepoInfo> {
            // Mirror RealRepoResolver: canonicalize the input before lookup, so
            // both the canonical path (from add_trusted_path) and the raw path
            // (from remove_trusted_path / verify) resolve to the same key.
            let key = std::fs::canonicalize(path)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| path.to_string());
            self.repos.get(&key).cloned()
        }
        fn hash_file(&self, path: &str) -> std::result::Result<String, String> {
            crate::hash::hash_file(path).map_err(|e| e.to_string())
        }
    }

    /// Resolver backed by in-memory maps.
    #[derive(Default)]
    struct MapResolver {
        repos: HashMap<String, RepoInfo>,
    }
    impl RepoResolver for MapResolver {
        fn repo_info(&self, path: &str) -> Option<RepoInfo> {
            self.repos.get(path).cloned()
        }
        fn hash_file(&self, _path: &str) -> std::result::Result<String, String> {
            Err("unused".into())
        }
    }

    fn io_for(home: &Path) -> FakeIo {
        FakeIo::new().with_env("HOME", home.to_str().unwrap())
    }

    #[test]
    fn schema_url_strips_commit_suffix() {
        assert_eq!(
            settings_schema_url("1.8.1+deadbeef"),
            "https://raw.githubusercontent.com/kexi/vibe/v1.8.1/schemas/settings.schema.json"
        );
    }

    #[test]
    fn load_missing_returns_defaults() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        let resolver = MapResolver::default();
        let s = load_user_settings(&io, &resolver, V).unwrap();
        assert_eq!(s, VibeSettings::default_settings());
    }

    #[test]
    fn load_parse_error_propagates() {
        let fx = Fixture::new();
        let _ = fx.write(".config/vibe/settings.json", "{ not json");
        let io = io_for(fx.path());
        let resolver = MapResolver::default();
        assert!(load_user_settings(&io, &resolver, V).is_err());
    }

    #[test]
    fn save_writes_schema_first_and_trailing_newline() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        let settings = VibeSettings::default_settings();
        save_user_settings(&io, &settings, V).unwrap();

        let path = get_settings_path(fx.path().to_str().unwrap()).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.ends_with("}\n"));
        // `$schema` is the very first key.
        let first_key_pos = written.find("\"$schema\"").unwrap();
        let version_pos = written.find("\"version\"").unwrap();
        assert!(first_key_pos < version_pos);
        assert!(written.contains("/v1.8.1/"));
    }

    #[cfg(unix)]
    #[test]
    fn saved_settings_file_is_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let fx = Fixture::new();
        let io = io_for(fx.path());
        save_user_settings(&io, &VibeSettings::default_settings(), V).unwrap();
        let path = get_settings_path(fx.path().to_str().unwrap()).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "settings.json must be 0600");
    }

    #[test]
    fn save_user_settings_golden_bytes() {
        // Golden on-disk format: `$schema` first, version, skipHashCheck, then
        // permissions; pretty-printed with 2-space indent and a trailing newline.
        // This locks the EXACT bytes so Phase 3's trust/untrust (which write the
        // same file) cannot silently change the format the TS reader expects.
        let fx = Fixture::new();
        let io = io_for(fx.path());
        save_user_settings(&io, &VibeSettings::default_settings(), V).unwrap();
        let path = get_settings_path(fx.path().to_str().unwrap()).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();

        let expected = "{\n  \"$schema\": \"https://raw.githubusercontent.com/kexi/vibe/v1.8.1/schemas/settings.schema.json\",\n  \"version\": 3,\n  \"skipHashCheck\": false,\n  \"permissions\": {\n    \"allow\": [],\n    \"deny\": []\n  }\n}\n";
        assert_eq!(written, expected, "settings.json on-disk format drifted");
    }

    #[test]
    fn round_trip_load_after_save() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        let mut settings = VibeSettings::default_settings();
        settings.permissions = Permissions {
            allow: vec![AllowEntry {
                repo_id: RepoId {
                    remote_url: Some("github.com/u/r".into()),
                    repo_root: Some("/repo".into()),
                },
                relative_path: ".vibe.toml".into(),
                hashes: vec!["h1".into()],
                skip_hash_check: None,
            }],
            deny: vec![],
        };
        save_user_settings(&io, &settings, V).unwrap();
        let resolver = MapResolver::default();
        let loaded = load_user_settings(&io, &resolver, V).unwrap();

        // The on-disk file carries the injected `$schema`, which load captures
        // into `extra` (it round-trips, not silently dropped). Stamp it onto the
        // expected value so the comparison reflects the real persisted document.
        settings
            .extra
            .insert("$schema".to_string(), Value::String(settings_schema_url(V)));
        assert_eq!(loaded, settings);
    }

    #[test]
    fn load_save_preserves_worktree_clean_and_unknown_keys() {
        // A hand-edited v3 settings file with worktree/clean (TS-modeled but not
        // typed in Rust) plus an unknown key and a stale `$schema`. After a
        // load→save cycle (what Phase 3 trust/untrust will do) every key must
        // survive, with exactly one `$schema` emitted first and freshly tagged.
        let fx = Fixture::new();
        let io = io_for(fx.path());
        let on_disk = serde_json::json!({
            "$schema": "https://raw.githubusercontent.com/kexi/vibe/v0.0.1/schemas/settings.schema.json",
            "version": 3,
            "skipHashCheck": false,
            "worktree": { "path_script": "echo /tmp/wt" },
            "clean": { "fast_remove": true },
            "futureKey": 42,
            "permissions": { "allow": [], "deny": [] },
        });
        let _ = fx.write(
            ".config/vibe/settings.json",
            serde_json::to_string_pretty(&on_disk).unwrap(),
        );

        let resolver = MapResolver::default();
        let loaded = load_user_settings(&io, &resolver, V).unwrap();
        // Already at the current version → no implicit persist on load.
        save_user_settings(&io, &loaded, V).unwrap();

        let path = get_settings_path(fx.path().to_str().unwrap()).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        let value: Value = serde_json::from_str(&written).unwrap();

        // worktree / clean / unknown key all survive verbatim.
        assert_eq!(
            value["worktree"],
            serde_json::json!({ "path_script": "echo /tmp/wt" })
        );
        assert_eq!(value["clean"], serde_json::json!({ "fast_remove": true }));
        assert_eq!(value["futureKey"], serde_json::json!(42));

        // Exactly one `$schema`, emitted first, with the fresh (V-tagged) URL.
        assert_eq!(written.matches("\"$schema\"").count(), 1);
        let schema_pos = written.find("\"$schema\"").unwrap();
        let version_pos = written.find("\"version\"").unwrap();
        assert!(schema_pos < version_pos, "$schema must precede version");
        assert!(written.contains("/v1.8.1/"), "fresh schema URL: {written}");
        assert!(!written.contains("/v0.0.1/"), "stale schema URL leaked");
    }

    #[test]
    fn verify_returns_hashed_content_on_match() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        // Write a .vibe.toml and trust its current hash.
        let vibe_path = fx.write("repo/.vibe.toml", "trusted = true\n");
        let vibe_path_str = vibe_path.to_str().unwrap().to_string();
        let content_hash = hash_content(b"trusted = true\n");

        let mut settings = VibeSettings::default_settings();
        settings.permissions.allow.push(AllowEntry {
            repo_id: RepoId {
                remote_url: None,
                repo_root: Some("/repo".into()),
            },
            relative_path: ".vibe.toml".into(),
            hashes: vec![content_hash],
            skip_hash_check: None,
        });
        save_user_settings(&io, &settings, V).unwrap();

        let mut repos = HashMap::new();
        repos.insert(
            vibe_path_str.clone(),
            RepoInfo {
                remote_url: None,
                repo_root: "/repo".into(),
                relative_path: ".vibe.toml".into(),
            },
        );
        let resolver = MapResolver { repos };

        let (trusted, content) = verify_trust_and_read(&io, &resolver, V, &vibe_path_str).unwrap();
        assert!(trusted);
        // The returned content is exactly what was hashed (TOCTOU-safe).
        assert_eq!(content.as_deref(), Some("trusted = true\n"));
    }

    #[test]
    fn verify_untrusted_when_not_in_repo() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        let vibe_path = fx.write("loose/.vibe.toml", "x\n");
        let resolver = MapResolver::default(); // No repo info.
        let (trusted, content) =
            verify_trust_and_read(&io, &resolver, V, vibe_path.to_str().unwrap()).unwrap();
        assert!(!trusted);
        assert_eq!(content, None);
    }

    #[test]
    fn verify_untrusted_on_hash_mismatch() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        let vibe_path = fx.write("repo/.vibe.toml", "changed = true\n");
        let vibe_path_str = vibe_path.to_str().unwrap().to_string();

        let mut settings = VibeSettings::default_settings();
        settings.permissions.allow.push(AllowEntry {
            repo_id: RepoId {
                remote_url: None,
                repo_root: Some("/repo".into()),
            },
            relative_path: ".vibe.toml".into(),
            hashes: vec!["stale-hash".into()],
            skip_hash_check: None,
        });
        save_user_settings(&io, &settings, V).unwrap();

        let mut repos = HashMap::new();
        repos.insert(
            vibe_path_str.clone(),
            RepoInfo {
                remote_url: None,
                repo_root: "/repo".into(),
                relative_path: ".vibe.toml".into(),
            },
        );
        let resolver = MapResolver { repos };
        let (trusted, content) = verify_trust_and_read(&io, &resolver, V, &vibe_path_str).unwrap();
        assert!(!trusted);
        assert_eq!(content, None);
    }

    // --- add_trusted_path / remove_trusted_path -----------------------------

    /// Build a HashingResolver whose `repo_info` knows the CANONICAL form of
    /// `file` (what `add_trusted_path` looks up after canonicalizing).
    fn resolver_for(file: &Path, info: RepoInfo) -> HashingResolver {
        let canon = std::fs::canonicalize(file).unwrap();
        let mut repos = HashMap::new();
        repos.insert(canon.to_string_lossy().into_owned(), info);
        HashingResolver { repos }
    }

    #[test]
    fn add_trusted_path_rejects_relative_path() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        let resolver = HashingResolver::default();
        let err = add_trusted_path(&io, &resolver, V, "relative/.vibe.toml").unwrap_err();
        assert!(
            err.to_string().contains("Path must be absolute"),
            "msg: {err}"
        );
    }

    #[test]
    fn add_trusted_path_errors_outside_git_repo() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        let file = fx.write("loose/.vibe.toml", "x = 1\n");
        // Resolver returns no repo info → not-in-repo error.
        let resolver = HashingResolver::default();
        let err = add_trusted_path(&io, &resolver, V, file.to_str().unwrap()).unwrap_err();
        assert!(
            err.to_string()
                .contains("Cannot trust file outside of git repository"),
            "msg: {err}"
        );
    }

    #[test]
    fn add_trusted_path_creates_new_entry_with_content_hash() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        let file = fx.write("repo/.vibe.toml", "trusted = true\n");
        let resolver = resolver_for(
            &file,
            RepoInfo {
                remote_url: Some("github.com/u/r".into()),
                repo_root: "/repo".into(),
                relative_path: ".vibe.toml".into(),
            },
        );

        add_trusted_path(&io, &resolver, V, file.to_str().unwrap()).unwrap();

        let loaded = load_user_settings(&io, &resolver, V).unwrap();
        assert_eq!(loaded.permissions.allow.len(), 1);
        let entry = &loaded.permissions.allow[0];
        assert_eq!(entry.relative_path, ".vibe.toml");
        assert_eq!(entry.repo_id.remote_url.as_deref(), Some("github.com/u/r"));
        assert_eq!(entry.repo_id.repo_root.as_deref(), Some("/repo"));
        // The stored hash is of the file's REAL bytes (the unified-path fix).
        assert_eq!(entry.hashes, vec![hash_content(b"trusted = true\n")]);
    }

    #[cfg(unix)]
    #[test]
    fn add_trusted_path_writes_ts_shaped_entry_golden() {
        // D3: golden on-disk shape after add_trusted_path. The persisted entry
        // must use the TS camelCase keys (`repoId.repoRoot`, `relativePath`,
        // `hashes`), OMIT `skipHashCheck` when None, the file must be 0600, and
        // `$schema` must be the first key. A local repo (no remote) must NOT emit
        // a `remoteUrl` key (skip_serializing_if).
        use std::os::unix::fs::PermissionsExt;
        let fx = Fixture::new();
        let io = io_for(fx.path());
        let file = fx.write("repo/.vibe.toml", "trusted = true\n");
        let resolver = resolver_for(
            &file,
            RepoInfo {
                remote_url: None,
                repo_root: "/repo".into(),
                relative_path: ".vibe.toml".into(),
            },
        );

        add_trusted_path(&io, &resolver, V, file.to_str().unwrap()).unwrap();

        let path = get_settings_path(fx.path().to_str().unwrap()).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();

        // 0600 permissions.
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "settings.json must be 0600");

        // `$schema` first.
        let schema_pos = written.find("\"$schema\"").unwrap();
        let version_pos = written.find("\"version\"").unwrap();
        assert!(schema_pos < version_pos, "$schema must precede version");

        // The exact allow entry, parsed back as JSON for key-shape assertions.
        let value: Value = serde_json::from_str(&written).unwrap();
        let entry = &value["permissions"]["allow"][0];
        assert_eq!(entry["repoId"]["repoRoot"], serde_json::json!("/repo"));
        // No remote → no remoteUrl key at all (skip_serializing_if).
        assert!(
            entry["repoId"].get("remoteUrl").is_none(),
            "remoteUrl must be omitted for a local repo: {entry}"
        );
        assert_eq!(entry["relativePath"], serde_json::json!(".vibe.toml"));
        assert_eq!(
            entry["hashes"],
            serde_json::json!([hash_content(b"trusted = true\n")])
        );
        // skipHashCheck omitted when None.
        assert!(
            entry.get("skipHashCheck").is_none(),
            "skipHashCheck must be omitted when None: {entry}"
        );
    }

    #[test]
    fn add_trusted_path_appends_hash_to_existing_entry_and_dedups() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        let file = fx.write("repo/.vibe.toml", "v = 1\n");
        let resolver = resolver_for(
            &file,
            RepoInfo {
                remote_url: None,
                repo_root: "/repo".into(),
                relative_path: ".vibe.toml".into(),
            },
        );

        // First trust: one hash.
        add_trusted_path(&io, &resolver, V, file.to_str().unwrap()).unwrap();
        // Re-trust the SAME content: dedup → still one hash.
        add_trusted_path(&io, &resolver, V, file.to_str().unwrap()).unwrap();
        let loaded = load_user_settings(&io, &resolver, V).unwrap();
        assert_eq!(loaded.permissions.allow.len(), 1);
        assert_eq!(loaded.permissions.allow[0].hashes.len(), 1);

        // Edit the file → new content hash appended to the SAME entry (FIFO).
        std::fs::write(&file, b"v = 2\n").unwrap();
        add_trusted_path(&io, &resolver, V, file.to_str().unwrap()).unwrap();
        let loaded = load_user_settings(&io, &resolver, V).unwrap();
        assert_eq!(loaded.permissions.allow.len(), 1, "no second entry");
        assert_eq!(
            loaded.permissions.allow[0].hashes,
            vec![hash_content(b"v = 1\n"), hash_content(b"v = 2\n")]
        );
    }

    #[test]
    fn add_trusted_path_unifies_symlink_path_for_repo_and_hash() {
        // SECURITY (point 6): registering through a SYMLINK must store the hash of
        // the REAL target's bytes under the REAL target's repo identity, so a
        // later verify (which hashes the resolved file) agrees. We give the
        // resolver repo info ONLY for the canonical target path; if the code
        // hashed/looked-up the raw symlink instead, repo_info would be None and
        // the call would error — so a successful trust proves the unification.
        #[cfg(unix)]
        {
            let fx = Fixture::new();
            let io = io_for(fx.path());
            let real = fx.write("repo/.vibe.toml", "real = true\n");
            let link = fx.path().join("link.toml");
            std::os::unix::fs::symlink(&real, &link).unwrap();

            // repo_info known ONLY for the canonical (real) path.
            let resolver = resolver_for(
                &real,
                RepoInfo {
                    remote_url: None,
                    repo_root: "/repo".into(),
                    relative_path: ".vibe.toml".into(),
                },
            );

            add_trusted_path(&io, &resolver, V, link.to_str().unwrap()).unwrap();
            let loaded = load_user_settings(&io, &resolver, V).unwrap();
            assert_eq!(loaded.permissions.allow.len(), 1);
            // Hash is of the REAL target bytes, not anything symlink-specific.
            assert_eq!(
                loaded.permissions.allow[0].hashes,
                vec![hash_content(b"real = true\n")]
            );
        }
    }

    #[test]
    fn remove_trusted_path_removes_matching_entry() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        let file = fx.write("repo/.vibe.toml", "x = 1\n");
        let resolver = resolver_for(
            &file,
            RepoInfo {
                remote_url: None,
                repo_root: "/repo".into(),
                relative_path: ".vibe.toml".into(),
            },
        );

        add_trusted_path(&io, &resolver, V, file.to_str().unwrap()).unwrap();
        assert_eq!(
            load_user_settings(&io, &resolver, V)
                .unwrap()
                .permissions
                .allow
                .len(),
            1
        );

        remove_trusted_path(&io, &resolver, V, file.to_str().unwrap()).unwrap();
        assert!(load_user_settings(&io, &resolver, V)
            .unwrap()
            .permissions
            .allow
            .is_empty());
    }

    #[test]
    fn remove_trusted_path_absent_is_noop() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        let file = fx.write("repo/.vibe.toml", "x = 1\n");
        let resolver = resolver_for(
            &file,
            RepoInfo {
                remote_url: None,
                repo_root: "/repo".into(),
                relative_path: ".vibe.toml".into(),
            },
        );
        // Nothing was trusted → removal is a no-op (still saves empty settings).
        remove_trusted_path(&io, &resolver, V, file.to_str().unwrap()).unwrap();
        assert!(load_user_settings(&io, &resolver, V)
            .unwrap()
            .permissions
            .allow
            .is_empty());
    }

    #[test]
    fn remove_trusted_path_warns_when_repo_undeterminable() {
        let fx = Fixture::new();
        let io = io_for(fx.path());
        let file = fx.write("loose/.vibe.toml", "x = 1\n");
        // Resolver has no repo info → warn + Ok, no save change.
        let resolver = HashingResolver::default();
        remove_trusted_path(&io, &resolver, V, file.to_str().unwrap()).unwrap();
        assert!(
            io.stderr_text().contains("Cannot determine repository for"),
            "stderr: {}",
            io.stderr_text()
        );
    }
}
