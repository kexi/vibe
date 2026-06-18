//! `vibe trust`: record `.vibe.toml` / `.vibe.local.toml` as trusted.
//!
//! Ported from `packages/core/src/commands/trust.ts`. Discovers the two config
//! files under the repo root, trusts each that exists (collecting per-file
//! errors instead of aborting on the first), and reports the result. All human
//! output goes to stderr; the command produces no `cd`, so it returns
//! [`Outcome::none`].

use crate::commands::Outcome;
use crate::config_loader::{VIBE_LOCAL_TOML, VIBE_TOML};
use crate::error::{Result, VibeError};
use crate::git::{get_repo_root, GitRunner};
use crate::io::Io;
use crate::output::{error_log, log, success_log, OutputOptions};
use crate::repo_info::get_repo_info_from_path;
use crate::settings::RepoResolver;
use crate::settings_io::{add_trusted_path, get_settings_path};
use std::path::Path;

/// Run `vibe trust`.
///
/// `resolver` is used both by `add_trusted_path` and to re-resolve each trusted
/// file's repo info for the report. `runner` resolves the repo root. The
/// `version` flows into any settings save (for the `$schema` URL).
pub fn trust_command(
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
        return Err(silent_exit());
    }

    let mut trusted: Vec<(String, Option<crate::git::RepoInfo>)> = Vec::new();
    let mut errors: Vec<(String, String)> = Vec::new();

    for (exists, path, label) in [
        (toml_exists, &vibe_toml, VIBE_TOML),
        (local_exists, &vibe_local, VIBE_LOCAL_TOML),
    ] {
        if !exists {
            continue;
        }
        let path_str = path.to_string_lossy().into_owned();
        match add_trusted_path(io, resolver, version, &path_str) {
            Ok(()) => {
                let info = get_repo_info_from_path(runner, &path_str);
                trusted.push((path_str, info));
            }
            Err(e) => errors.push((label.to_string(), error_message(&e))),
        }
    }

    if !errors.is_empty() {
        error_log(io, "Failed to trust the following files:");
        for (file, error) in &errors {
            error_log(io, &format!("  {file}: {error}"));
        }
        return Err(silent_exit());
    }

    success_log(io, "Trusted files:", opts);
    for (path, info) in &trusted {
        log(io, &format!("  {path}"), opts);
        match info {
            Some(i) if i.remote_url.is_some() => {
                log(
                    io,
                    &format!("    Repository: {}", i.remote_url.as_deref().unwrap()),
                    opts,
                );
                log(io, &format!("    Relative Path: {}", i.relative_path), opts);
            }
            Some(i) => {
                log(
                    io,
                    &format!("    Repository: (local) {}", i.repo_root),
                    opts,
                );
                log(io, &format!("    Relative Path: {}", i.relative_path), opts);
            }
            None => {}
        }
    }
    let settings_path = settings_path_string(io)?;
    log(io, &format!("\nSettings: {settings_path}"), opts);

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

/// The command printed its own diagnostics; this error only carries exit 1
/// (the binary prints nothing further for `AlreadyReported`). Mirrors the TS
/// `errorLog(...)` + `exit(1)`.
fn silent_exit() -> VibeError {
    VibeError::AlreadyReported
}

/// Human message for an error to embed in the per-file failure list (no prefix).
fn error_message(e: &VibeError) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::FakeIo;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use vibe_test_support::Fixture;

    const V: &str = "1.8.1+abc";

    /// Git mock: serves a fixed repo root and answers `config --get` for the
    /// trust resolver's remote lookup; records calls.
    struct RootGit {
        root: String,
        /// Optional `remote.origin.url` served to `get_repo_info_from_path` (the
        /// REPORT re-resolves each trusted file's repo info through the real git
        /// runner, not the trust resolver). `None` → errors like a local repo.
        remote: Option<String>,
        calls: RefCell<Vec<Vec<String>>>,
    }
    impl RootGit {
        fn new(root: &str) -> Self {
            RootGit {
                root: root.to_string(),
                remote: None,
                calls: RefCell::new(vec![]),
            }
        }
        fn with_remote(root: &str, remote: &str) -> Self {
            RootGit {
                root: root.to_string(),
                remote: Some(remote.to_string()),
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
            // `config --get remote.origin.url` (from get_repo_info_from_path).
            match &self.remote {
                Some(url) => Ok(url.clone()),
                None => Err(VibeError::GitOperation {
                    command: args.join(" "),
                    message: "failed: no remote".into(),
                }),
            }
        }
    }

    /// Resolver keyed by the CANONICAL file path (add_trusted_path canonicalizes).
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

    use crate::git::RepoInfo;

    fn register(
        repos: &mut HashMap<String, RepoInfo>,
        file: &std::path::Path,
        rel: &str,
        root: &str,
    ) {
        let canon = std::fs::canonicalize(file).unwrap();
        repos.insert(
            canon.to_string_lossy().into_owned(),
            RepoInfo {
                remote_url: None,
                repo_root: root.into(),
                relative_path: rel.into(),
            },
        );
    }

    #[test]
    fn neither_file_errors() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let git = RootGit::new(repo.to_str().unwrap());
        let resolver = MapResolver::default();
        let err = trust_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));
        assert!(io
            .stderr_text()
            .contains("Neither .vibe.toml nor .vibe.local.toml found in"));
    }

    #[test]
    fn trusts_both_files_and_reports() {
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
        let mut repos = HashMap::new();
        register(&mut repos, &base, ".vibe.toml", &canon_root);
        register(&mut repos, &local, ".vibe.local.toml", &canon_root);
        let resolver = MapResolver { repos };

        let outcome = trust_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::none());

        // R-3: assert the FULL ordered multi-line output (one Vec element per
        // `log` call). Paths are the JOINED (non-canonical) repo_root + file.
        let base_str = repo.join(".vibe.toml").to_string_lossy().into_owned();
        let local_str = repo.join(".vibe.local.toml").to_string_lossy().into_owned();
        let settings_path = crate::settings_io::get_settings_path(fx.path().to_str().unwrap())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let lines = io.stderr.borrow().clone();
        assert_eq!(
            lines,
            vec![
                "Trusted files:".to_string(),
                format!("  {base_str}"),
                format!("    Repository: (local) {canon_root}"),
                "    Relative Path: .vibe.toml".to_string(),
                format!("  {local_str}"),
                format!("    Repository: (local) {canon_root}"),
                "    Relative Path: .vibe.local.toml".to_string(),
                // The LEADING newline before Settings is part of the line itself.
                format!("\nSettings: {settings_path}"),
            ],
            "trust success output drifted: {lines:?}"
        );

        // Both entries persisted.
        let loaded = crate::settings_io::load_user_settings(&io, &resolver, V).unwrap();
        assert_eq!(loaded.permissions.allow.len(), 2);
    }

    #[test]
    fn trust_with_remote_url_omits_local_prefix() {
        // R-4: a repo WITH a remote_url prints `Repository: <url>` (no `(local)`).
        // The REPORT re-resolves repo info via the real git runner, so the remote
        // is served by RootGit (config --get), not the trust MapResolver.
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let base = fx.write("repo/.vibe.toml", "a = 1\n");
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        // Root must canonically contain the file so containment passes.
        let canon_root = std::fs::canonicalize(&repo)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let git = RootGit::with_remote(&canon_root, "git@github.com:u/r.git");

        // Trust resolver only needs to let add_trusted_path succeed.
        let mut repos = HashMap::new();
        register(&mut repos, &base, ".vibe.toml", &canon_root);
        let resolver = MapResolver { repos };

        trust_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap();
        let out = io.stderr_text();
        // normalize_remote_url(git@github.com:u/r.git) → github.com/u/r.
        assert!(
            out.contains("    Repository: github.com/u/r"),
            "remote URL line missing: {out}"
        );
        assert!(
            !out.contains("(local)"),
            "remote-url branch must NOT print the (local) prefix: {out}"
        );
        assert!(out.contains("    Relative Path: .vibe.toml"));
    }

    #[test]
    fn partial_failure_reports_and_errors() {
        // R-5 (.vibe.local.toml fails, .vibe.toml succeeds): the failure block is
        // printed with the EXACT `Failed to trust the following files:` header +
        // `  <shortname>: <error>` line, the command returns Err, and NO success
        // output ("Trusted files:") is printed.
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let base = fx.write("repo/.vibe.toml", "a = 1\n");
        // local exists but the resolver does NOT know its repo → add fails.
        let _local = fx.write("repo/.vibe.local.toml", "b = 2\n");
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let git = RootGit::new(repo.to_str().unwrap());

        let canon_root = std::fs::canonicalize(&repo)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mut repos = HashMap::new();
        register(&mut repos, &base, ".vibe.toml", &canon_root);
        // intentionally NOT registering .vibe.local.toml
        let resolver = MapResolver { repos };

        let err = trust_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));
        let lines = io.stderr.borrow().clone();
        assert_eq!(lines.len(), 2, "exact failure block only: {lines:?}");
        assert_eq!(lines[0], "Failed to trust the following files:");
        // `  <shortname>: <error>` — the shortname is the bare file label.
        assert!(
            lines[1].starts_with("  .vibe.local.toml: "),
            "failure line: {:?}",
            lines[1]
        );
        assert!(lines[1].contains("Cannot trust file outside of git repository"));
        // No success output was printed.
        assert!(
            !lines.iter().any(|l| l.contains("Trusted files:")),
            "success output must be suppressed on failure: {lines:?}"
        );
    }

    #[test]
    fn partial_failure_other_direction_base_fails() {
        // R-5 (other direction): .vibe.toml FAILS, .vibe.local.toml would succeed.
        // The failure short-circuits the whole command: the error block names
        // ONLY .vibe.toml, returns Err, and prints no success output.
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        // base exists but the resolver does NOT know its repo → add fails.
        let _base = fx.write("repo/.vibe.toml", "a = 1\n");
        let local = fx.write("repo/.vibe.local.toml", "b = 2\n");
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let git = RootGit::new(repo.to_str().unwrap());

        let canon_root = std::fs::canonicalize(&repo)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mut repos = HashMap::new();
        register(&mut repos, &local, ".vibe.local.toml", &canon_root);
        // intentionally NOT registering .vibe.toml
        let resolver = MapResolver { repos };

        let err = trust_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap_err();
        assert!(matches!(err, VibeError::AlreadyReported));
        let lines = io.stderr.borrow().clone();
        assert_eq!(lines.len(), 2, "exact failure block only: {lines:?}");
        assert_eq!(lines[0], "Failed to trust the following files:");
        assert!(
            lines[1].starts_with("  .vibe.toml: "),
            "failure line: {:?}",
            lines[1]
        );
        assert!(
            !lines.iter().any(|l| l.contains("Trusted files:")),
            "success output must be suppressed on failure: {lines:?}"
        );
    }
}
