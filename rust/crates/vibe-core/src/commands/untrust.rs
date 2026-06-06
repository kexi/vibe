//! `vibe untrust`: remove `.vibe.toml` / `.vibe.local.toml` from the trust store.
//!
//! Ported from `packages/core/src/commands/untrust.ts`. Discovers the config
//! files under the repo root and removes each that exists, reporting the result
//! to stderr. Produces no `cd` → [`Outcome::none`].

use crate::commands::Outcome;
use crate::config_loader::{VIBE_LOCAL_TOML, VIBE_TOML};
use crate::error::{Result, VibeError};
use crate::git::{get_repo_root, GitRunner};
use crate::io::Io;
use crate::output::{error_log, log, success_log, OutputOptions};
use crate::settings::RepoResolver;
use crate::settings_io::{get_settings_path, remove_trusted_path};
use std::path::Path;

/// Run `vibe untrust`.
pub fn untrust_command(
    io: &impl Io,
    runner: &impl GitRunner,
    resolver: &impl RepoResolver,
    version: &str,
    opts: OutputOptions,
) -> Result<Outcome> {
    let repo_root = get_repo_root(runner)?;
    let vibe_toml = Path::new(&repo_root).join(VIBE_TOML);
    let vibe_local = Path::new(&repo_root).join(VIBE_LOCAL_TOML);

    let toml_exists = vibe_toml.exists();
    let local_exists = vibe_local.exists();
    if !toml_exists && !local_exists {
        error_log(
            io,
            &format!("Error: Neither .vibe.toml nor .vibe.local.toml found in {repo_root}"),
        );
        return Err(VibeError::AlreadyReported);
    }

    let mut untrusted: Vec<String> = Vec::new();
    for (exists, path) in [(toml_exists, &vibe_toml), (local_exists, &vibe_local)] {
        if !exists {
            continue;
        }
        let path_str = path.to_string_lossy().into_owned();
        remove_trusted_path(io, resolver, version, &path_str)?;
        untrusted.push(path_str);
    }

    for file in &untrusted {
        success_log(io, &format!("Untrusted: {file}"), opts);
    }
    let settings_path = settings_path_string(io)?;
    log(io, &format!("Settings: {settings_path}"), opts);

    Ok(Outcome::none())
}

/// The `~/.config/vibe/settings.json` path as a display string.
fn settings_path_string(io: &impl Io) -> Result<String> {
    let home = io
        .home()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| VibeError::Configuration("HOME environment variable is not set".into()))?;
    Ok(get_settings_path(&home)?.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::RepoInfo;
    use crate::io::FakeIo;
    use crate::settings::{AllowEntry, RepoId, VibeSettings};
    use crate::settings_io::{load_user_settings, save_user_settings};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use vibe_test_support::Fixture;

    const V: &str = "1.8.1+abc";

    struct RootGit {
        root: String,
        calls: RefCell<Vec<Vec<String>>>,
    }
    impl RootGit {
        fn new(root: &str) -> Self {
            RootGit {
                root: root.to_string(),
                calls: RefCell::new(vec![]),
            }
        }
    }
    impl GitRunner for RootGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            self.calls
                .borrow_mut()
                .push(args.iter().map(|s| s.to_string()).collect());
            if args.contains(&"--show-toplevel") {
                return Ok(self.root.clone());
            }
            Err(VibeError::GitOperation {
                command: args.join(" "),
                message: "failed".into(),
            })
        }
    }

    #[derive(Default)]
    struct MapResolver {
        repos: HashMap<String, RepoInfo>,
    }
    impl RepoResolver for MapResolver {
        fn repo_info(&self, path: &str) -> Option<RepoInfo> {
            let key = std::fs::canonicalize(path)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| path.to_string());
            self.repos.get(&key).cloned()
        }
        fn hash_file(&self, path: &str) -> std::result::Result<String, String> {
            crate::hash::hash_file(path).map_err(|e| e.to_string())
        }
    }

    #[test]
    fn neither_file_errors() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let git = RootGit::new(repo.to_str().unwrap());
        let resolver = MapResolver::default();
        let err = untrust_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));
    }

    #[test]
    fn untrusts_existing_file_and_reports() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let file = fx.write("repo/.vibe.toml", "a = 1\n");
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let git = RootGit::new(repo.to_str().unwrap());

        let canon_root = std::fs::canonicalize(&repo)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        // Pre-seed a trust entry to be removed.
        let mut settings = VibeSettings::default_settings();
        settings.permissions.allow.push(AllowEntry {
            repo_id: RepoId {
                remote_url: None,
                repo_root: Some(canon_root.clone()),
            },
            relative_path: ".vibe.toml".into(),
            hashes: vec!["h".into()],
            skip_hash_check: None,
        });
        save_user_settings(&io, &settings, V).unwrap();

        let mut repos = HashMap::new();
        repos.insert(
            std::fs::canonicalize(&file)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            RepoInfo {
                remote_url: None,
                repo_root: canon_root,
                relative_path: ".vibe.toml".into(),
            },
        );
        let resolver = MapResolver { repos };

        let outcome = untrust_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::none());
        let file_str = file.to_string_lossy().into_owned();
        let settings_path = get_settings_path(fx.path().to_str().unwrap())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let lines = io.stderr.borrow().clone();
        assert_eq!(
            lines,
            vec![
                format!("Untrusted: {file_str}"),
                format!("Settings: {settings_path}"),
            ],
            "untrust output drifted: {lines:?}"
        );

        // The entry is gone.
        let loaded = load_user_settings(&io, &resolver, V).unwrap();
        assert!(loaded.permissions.allow.is_empty());
    }

    #[test]
    fn untrusts_both_files_and_reports_ordered() {
        // R-3 (untrust, both files): both `Untrusted: <path>` lines (base then
        // local) followed by the single `Settings:` line, in exact order.
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let base = fx.write("repo/.vibe.toml", "a = 1\n");
        let local = fx.write("repo/.vibe.local.toml", "b = 2\n");
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let git = RootGit::new(repo.to_str().unwrap());

        let canon_root = std::fs::canonicalize(&repo)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        // Pre-seed both trust entries.
        let mut settings = VibeSettings::default_settings();
        for file in [".vibe.toml", ".vibe.local.toml"] {
            settings.permissions.allow.push(AllowEntry {
                repo_id: RepoId {
                    remote_url: None,
                    repo_root: Some(canon_root.clone()),
                },
                relative_path: file.into(),
                hashes: vec!["h".into()],
                skip_hash_check: None,
            });
        }
        save_user_settings(&io, &settings, V).unwrap();

        let mut repos = HashMap::new();
        for (file, rel) in [(&base, ".vibe.toml"), (&local, ".vibe.local.toml")] {
            repos.insert(
                std::fs::canonicalize(file)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                RepoInfo {
                    remote_url: None,
                    repo_root: canon_root.clone(),
                    relative_path: rel.into(),
                },
            );
        }
        let resolver = MapResolver { repos };

        untrust_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap();

        let base_str = base.to_string_lossy().into_owned();
        let local_str = local.to_string_lossy().into_owned();
        let settings_path = get_settings_path(fx.path().to_str().unwrap())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let lines = io.stderr.borrow().clone();
        assert_eq!(
            lines,
            vec![
                format!("Untrusted: {base_str}"),
                format!("Untrusted: {local_str}"),
                format!("Settings: {settings_path}"),
            ],
            "untrust (both) output drifted: {lines:?}"
        );

        // Both entries removed.
        let loaded = load_user_settings(&io, &resolver, V).unwrap();
        assert!(loaded.permissions.allow.is_empty());
    }
}
