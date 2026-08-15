//! Trust-gated loading of `.vibe.toml` / `.vibe.local.toml`.
//!
//! Ported from `loadVibeConfig` in `packages/core/src/utils/config.ts`. The pure
//! parse/merge logic lives in [`crate::config`]; this module wires it to the
//! trust store: each file is read THROUGH [`verify_trust_and_read`], and the
//! exact bytes that the trust decision was made on are parsed — never re-opened
//! — to close the TOCTOU window.
//!
//! Divergence from the TS (intentional): the TS printed an error and called
//! `exit(1)` for an untrusted file (a side effect buried in a loader). Here an
//! untrusted file is surfaced as an [`VibeError::Configuration`] so the binary
//! owns the exit, keeping vibe-core free of process-exit side effects. The
//! message text mirrors the TS (`<file> is not trusted or has been modified.\n
//! Please run: vibe trust`), prefixed with the offending file path.
//!
//! Second divergence (issue #599): the TS reached `mergeConfigs` only when BOTH
//! files existed, so with a lone `.vibe.toml` every `*_prepend`/`*_append` field
//! was parsed and then silently ignored. Every arm now runs the file through
//! [`normalize_config`], making the within-file extension fields effective
//! regardless of how many config files a repo has.

use crate::config::{merge_configs, normalize_config, parse_vibe_config, VibeConfig};
use crate::error::{Result, VibeError};
use crate::io::Io;
use crate::settings::RepoResolver;
use crate::settings_io::verify_trust_and_read;
use std::path::Path;

/// The repository-level config file name. Single source of truth: the trust
/// commands and any future config-aware command reference these rather than
/// redefining the literals (the TS had each command file declare its own).
pub const VIBE_TOML: &str = ".vibe.toml";
/// The machine-local override config file name.
pub const VIBE_LOCAL_TOML: &str = ".vibe.local.toml";

/// Load and merge the trusted config under `repo_root`.
///
/// For `.vibe.toml` then `.vibe.local.toml`: if the file exists, verify trust
/// and parse the verified content. Each file's own `*_prepend`/`*_append`
/// fields are then resolved within that file (`prepend ++ field ++ append`),
/// and the local file merges OVER the base's effective config. Returns the
/// merged config, or `None` when neither file exists. An existing-but-untrusted
/// (or modified) file is an error — per file, naming that file.
pub fn load_vibe_config(
    io: &impl Io,
    resolver: &impl RepoResolver,
    version: &str,
    repo_root: &str,
) -> Result<Option<VibeConfig>> {
    let base = load_one(io, resolver, version, repo_root, VIBE_TOML)?;
    let local = load_one(io, resolver, version, repo_root, VIBE_LOCAL_TOML)?;

    // Why not normalize `local` too before merging: an extension-only local
    // (e.g. only `files_append`) must reach merge_array_field with its field
    // slot still None so it WRAPS the base's effective array. Pre-folding it
    // would turn it into an override and replace the base — the documented
    // cross-file merge table depends on that distinction.
    let merged = match (base, local) {
        (Some(base), Some(local)) => Some(merge_configs(&normalize_config(&base), &local)),
        (Some(single), None) | (None, Some(single)) => Some(normalize_config(&single)),
        (None, None) => None,
    };
    Ok(merged)
}

/// Load a single config file by name under `repo_root`, gated by trust.
///
/// - file absent → `Ok(None)`
/// - present + trusted → `Ok(Some(parsed))` using the VERIFIED content (no
///   re-read; TOCTOU-safe)
/// - present + untrusted/modified → `Err(Configuration)` naming the file
fn load_one(
    io: &impl Io,
    resolver: &impl RepoResolver,
    version: &str,
    repo_root: &str,
    file_name: &str,
) -> Result<Option<VibeConfig>> {
    let path = Path::new(repo_root).join(file_name);
    let path_str = path.to_string_lossy();

    let exists = path.exists();
    if !exists {
        return Ok(None);
    }

    let (trusted, content) = verify_trust_and_read(io, resolver, version, &path_str)?;
    if !trusted {
        return Err(VibeError::Configuration(format!(
            "{path_str}: {file_name} file is not trusted or has been modified.\nPlease run: vibe trust"
        )));
    }

    // `trusted` implies `content` is Some; parse THOSE bytes, never re-open.
    let content = content.unwrap_or_default();
    let config = parse_vibe_config(&content, &path_str)?;
    Ok(Some(config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::RepoInfo;
    use crate::hash::hash_content;
    use crate::io::FakeIo;
    use crate::settings::{AllowEntry, RepoId, VibeSettings};
    use crate::settings_io::save_user_settings;
    use std::collections::HashMap;
    use std::path::Path;
    use vibe_test_support::Fixture;

    const V: &str = "1.8.1+abc";

    /// Resolver mapping a fixed set of paths to repo info; hash via real files.
    #[derive(Default)]
    struct MapResolver {
        repos: HashMap<String, RepoInfo>,
    }
    impl RepoResolver for MapResolver {
        fn repo_info(&self, path: &str) -> Option<RepoInfo> {
            self.repos.get(path).cloned()
        }
        fn hash_file(&self, path: &str) -> std::result::Result<String, String> {
            crate::hash::hash_file(path).map_err(|e| e.to_string())
        }
    }

    fn io_for(home: &Path) -> FakeIo {
        FakeIo::new().with_env("HOME", home.to_str().unwrap())
    }

    /// Register `repo_root/<file>` as trusted (its current content hash) and
    /// return the resolver knowing its repo info.
    fn trust_file(io: &FakeIo, repo_root: &Path, file: &str, content: &str) -> MapResolver {
        let file_path = repo_root.join(file);
        let mut settings = VibeSettings::default_settings();
        settings.permissions.allow.push(AllowEntry {
            repo_id: RepoId {
                remote_url: None,
                repo_root: Some(repo_root.to_string_lossy().into_owned()),
            },
            relative_path: file.into(),
            hashes: vec![hash_content(content.as_bytes())],
            skip_hash_check: None,
        });
        save_user_settings(io, &settings, V).unwrap();

        let mut repos = HashMap::new();
        repos.insert(
            file_path.to_string_lossy().into_owned(),
            RepoInfo {
                remote_url: None,
                repo_root: repo_root.to_string_lossy().into_owned(),
                relative_path: file.into(),
            },
        );
        MapResolver { repos }
    }

    /// Register BOTH config files as trusted and return a resolver knowing them.
    fn trust_both(io: &FakeIo, repo_root: &Path, base: &str, local: &str) -> MapResolver {
        let mut settings = VibeSettings::default_settings();
        let mut repos = HashMap::new();
        for (file, content) in [(VIBE_TOML, base), (VIBE_LOCAL_TOML, local)] {
            settings.permissions.allow.push(AllowEntry {
                repo_id: RepoId {
                    remote_url: None,
                    repo_root: Some(repo_root.to_string_lossy().into_owned()),
                },
                relative_path: file.into(),
                hashes: vec![hash_content(content.as_bytes())],
                skip_hash_check: None,
            });
            repos.insert(
                repo_root.join(file).to_string_lossy().into_owned(),
                RepoInfo {
                    remote_url: None,
                    repo_root: repo_root.to_string_lossy().into_owned(),
                    relative_path: file.into(),
                },
            );
        }
        save_user_settings(io, &settings, V).unwrap();
        MapResolver { repos }
    }

    #[test]
    fn neither_file_returns_none() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let io = io_for(fx.path());
        let resolver = MapResolver::default();
        let cfg = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap()).unwrap();
        assert_eq!(cfg, None);
    }

    #[test]
    fn trusted_base_is_parsed() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let content = "[copy]\nfiles = [\".env\"]\n";
        let _ = fx.write("repo/.vibe.toml", content);
        let io = io_for(fx.path());
        let resolver = trust_file(&io, &repo, ".vibe.toml", content);

        let cfg = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(cfg.copy.unwrap().files, Some(vec![".env".to_string()]));
    }

    #[test]
    fn single_base_file_append_is_applied() {
        // Issue #599: with only .vibe.toml, files_append must still take effect.
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let content = "[copy]\nfiles = [\".env\"]\nfiles_append = [\".env.local\"]\n";
        let _ = fx.write("repo/.vibe.toml", content);
        let io = io_for(fx.path());
        let resolver = trust_file(&io, &repo, ".vibe.toml", content);

        let cfg = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            cfg.copy.unwrap().files,
            Some(vec![".env".to_string(), ".env.local".to_string()])
        );
    }

    #[test]
    fn single_base_file_hook_append_without_base_is_applied() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let content = "[hooks]\npost_start_append = [\"echo hi\"]\n";
        let _ = fx.write("repo/.vibe.toml", content);
        let io = io_for(fx.path());
        let resolver = trust_file(&io, &repo, ".vibe.toml", content);

        let cfg = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            cfg.hooks.unwrap().post_start,
            Some(vec!["echo hi".to_string()])
        );
    }

    #[test]
    fn local_only_append_is_applied() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let content = "[copy]\nfiles_append = [\".env.local\"]\n";
        let _ = fx.write("repo/.vibe.local.toml", content);
        let io = io_for(fx.path());
        let resolver = trust_file(&io, &repo, ".vibe.local.toml", content);

        let cfg = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            cfg.copy.unwrap().files,
            Some(vec![".env.local".to_string()])
        );
    }

    #[test]
    fn base_append_survives_when_local_exists() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let base = "[copy]\nfiles = [\".env\"]\nfiles_append = [\".base-app\"]\n";
        let local = "[clean]\ndelete_branch = true\n";
        let _ = fx.write("repo/.vibe.toml", base);
        let _ = fx.write("repo/.vibe.local.toml", local);
        let io = io_for(fx.path());
        let resolver = trust_both(&io, &repo, base, local);

        let cfg = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            cfg.copy.unwrap().files,
            Some(vec![".env".to_string(), ".base-app".to_string()])
        );
    }

    #[test]
    fn trusted_base_and_local_are_merged() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let base = "[copy]\nfiles = [\".env\"]\n";
        let local = "[copy]\nfiles_append = [\".env.local\"]\n";
        let _ = fx.write("repo/.vibe.toml", base);
        let _ = fx.write("repo/.vibe.local.toml", local);
        let io = io_for(fx.path());

        // Trust BOTH files (one settings doc, two allow entries).
        let mut settings = VibeSettings::default_settings();
        for (file, content) in [(".vibe.toml", base), (".vibe.local.toml", local)] {
            settings.permissions.allow.push(AllowEntry {
                repo_id: RepoId {
                    remote_url: None,
                    repo_root: Some(repo.to_string_lossy().into_owned()),
                },
                relative_path: file.into(),
                hashes: vec![hash_content(content.as_bytes())],
                skip_hash_check: None,
            });
        }
        save_user_settings(&io, &settings, V).unwrap();
        let mut repos = HashMap::new();
        for file in [".vibe.toml", ".vibe.local.toml"] {
            repos.insert(
                repo.join(file).to_string_lossy().into_owned(),
                RepoInfo {
                    remote_url: None,
                    repo_root: repo.to_string_lossy().into_owned(),
                    relative_path: file.into(),
                },
            );
        }
        let resolver = MapResolver { repos };

        let cfg = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap())
            .unwrap()
            .unwrap();
        // local files_append wraps the base files.
        assert_eq!(
            cfg.copy.unwrap().files,
            Some(vec![".env".to_string(), ".env.local".to_string()])
        );
    }

    #[test]
    fn untrusted_file_errors_with_filename() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        // File exists but is NOT in the allow list → untrusted.
        let _ = fx.write("repo/.vibe.local.toml", "[copy]\nfiles = []\n");
        let io = io_for(fx.path());
        // Resolver knows the repo (so it is "in a repo") but no settings entry.
        let mut repos = HashMap::new();
        repos.insert(
            repo.join(".vibe.local.toml").to_string_lossy().into_owned(),
            RepoInfo {
                remote_url: None,
                repo_root: repo.to_string_lossy().into_owned(),
                relative_path: ".vibe.local.toml".into(),
            },
        );
        let resolver = MapResolver { repos };

        let err = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap()).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains(".vibe.local.toml file is not trusted or has been modified"),
            "msg: {msg}"
        );
        assert!(msg.contains("Please run: vibe trust"), "msg: {msg}");
        // The offending file is named correctly (local, not base).
        assert!(msg.contains(".vibe.local.toml"), "msg: {msg}");
    }
}
