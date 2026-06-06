//! `vibe verify`: report trust status and hash history for the repo's config.
//!
//! Ported from `packages/core/src/commands/verify.ts`. Reads `.vibe.toml` and
//! `.vibe.local.toml` at the repo root, and for each prints repository identity,
//! a trust status line (trusted / not-trusted / hash-mismatch / skip), and the
//! stored hash history. Every line is reproduced to match the TS exactly,
//! including the emoji markers. No `cd` is produced.

use crate::commands::Outcome;
use crate::error::{Result, VibeError};
use crate::git::{get_repo_root, GitRunner};
use crate::hash::hash_file;
use crate::io::Io;
use crate::output::{error_log, log, success_log, warn_log, OutputOptions};
use crate::settings::RepoResolver;
use crate::settings::{find_matching_entry, should_skip_hash_check, VibeSettings};
use crate::settings_io::load_user_settings;
use std::path::Path;

const VIBE_TOML: &str = ".vibe.toml";
const VIBE_LOCAL_TOML: &str = ".vibe.local.toml";

/// Run `vibe verify`.
pub fn verify_command(
    io: &impl Io,
    git: &impl GitRunner,
    resolver: &impl RepoResolver,
    version: &str,
    opts: OutputOptions,
) -> Result<Outcome> {
    let repo_root = get_repo_root(git)?;
    let vibe_toml_path = Path::new(&repo_root).join(VIBE_TOML);
    let vibe_local_path = Path::new(&repo_root).join(VIBE_LOCAL_TOML);

    let vibe_exists = vibe_toml_path.exists();
    let local_exists = vibe_local_path.exists();

    let has_any = vibe_exists || local_exists;
    if !has_any {
        return Err(VibeError::FileSystem(format!(
            "Neither .vibe.toml nor .vibe.local.toml found in {repo_root}"
        )));
    }

    let settings = load_user_settings(io, resolver, version)?;

    log(io, "=== Vibe Configuration Verification ===\n", opts);

    if vibe_exists {
        display_file_status(
            io,
            resolver,
            &settings,
            vibe_toml_path.to_str().unwrap_or_default(),
            VIBE_TOML,
            opts,
        );
    }

    if local_exists {
        if vibe_exists {
            log(io, "", opts); // Blank line between files.
        }
        display_file_status(
            io,
            resolver,
            &settings,
            vibe_local_path.to_str().unwrap_or_default(),
            VIBE_LOCAL_TOML,
            opts,
        );
    }

    log(io, "\n=== Global Settings ===", opts);
    log(
        io,
        &format!(
            "Skip Hash Check: {}",
            settings.skip_hash_check.unwrap_or(false)
        ),
        opts,
    );

    Ok(Outcome::none())
}

/// Print the status block for one config file, mirroring `displayFileStatus`.
///
/// Display-only: it returns `()` and never propagates. In particular, if the
/// file becomes unreadable between the `exists()` check and the hash read, it
/// prints `Status: ❌ ERROR - Cannot read file: …` and returns early WITHOUT
/// surfacing an error to the caller, so `verify` still exits 0. This is
/// intentional and matches the TS `verify.ts` `displayFileStatus`, whose
/// `catch` block likewise logs `Status: ❌ ERROR - Cannot read file: …` and
/// `return`s (it does not rethrow). Changing this to a non-zero exit would
/// diverge from the TS observable behavior.
fn display_file_status(
    io: &impl Io,
    resolver: &impl RepoResolver,
    settings: &VibeSettings,
    file_path: &str,
    file_name: &str,
    opts: OutputOptions,
) {
    log(io, &format!("File: {file_name}"), opts);
    log(io, &format!("Path: {file_path}"), opts);

    let Some(repo_info) = resolver.repo_info(file_path) else {
        error_log(io, "Status: ❌ NOT IN GIT REPOSITORY");
        log(
            io,
            "Action: File must be in a git repository to be trusted",
            opts,
        );
        return;
    };

    match &repo_info.remote_url {
        Some(url) => log(io, &format!("Repository: {url}"), opts),
        None => log(
            io,
            &format!("Repository: (local) {}", repo_info.repo_root),
            opts,
        ),
    }
    log(
        io,
        &format!("Relative Path: {}", repo_info.relative_path),
        opts,
    );

    let Some(entry) = find_matching_entry(&settings.permissions.allow, &repo_info) else {
        warn_log(io, "Status: ⚠️  NOT TRUSTED");
        log(
            io,
            "Action: Run 'vibe trust' to add this file to trusted list",
            opts,
        );
        return;
    };

    let current_hash = match hash_file(file_path) {
        Ok(h) => h,
        Err(e) => {
            error_log(io, &format!("Status: ❌ ERROR - Cannot read file: {e}"));
            return;
        }
    };

    let hash_matches = entry.hashes.contains(&current_hash);
    let skip = should_skip_hash_check(entry, settings);

    if skip {
        warn_log(io, "Status: ⚠️  TRUSTED (hash check disabled)");
        log(io, "Skip Hash Check: true (path-level or global)", opts);
    } else if hash_matches {
        success_log(io, "Status: ✅ TRUSTED", opts);
        log(io, "Current Hash: matches stored hash", opts);
    } else {
        error_log(io, "Status: ❌ HASH MISMATCH");
        log(io, "Current Hash: does NOT match any stored hash", opts);
        log(
            io,
            "Action: Run 'vibe trust' to update hash, or verify file integrity",
            opts,
        );
    }

    log(
        io,
        &format!("\nHash History ({} stored):", entry.hashes.len()),
        opts,
    );
    for (index, hash) in entry.hashes.iter().enumerate() {
        let is_current = hash == &current_hash;
        let marker = if is_current { "→" } else { " " };
        let status = if is_current { " (current)" } else { "" };
        let prefix = &hash[..hash.len().min(16)];
        log(
            io,
            &format!("{marker} {}. {prefix}...{status}", index + 1),
            opts,
        );
    }

    if let Some(s) = entry.skip_hash_check {
        log(io, &format!("\nPath-level Skip Hash Check: {s}"), opts);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::RepoInfo;
    use crate::hash::hash_content;
    use crate::io::FakeIo;
    use crate::settings::{AllowEntry, RepoId};
    use crate::settings_io::save_user_settings;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use vibe_test_support::Fixture;

    const V: &str = "1.8.1+abc";

    struct FakeGit {
        repo_root: String,
    }
    impl GitRunner for FakeGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            if args.contains(&"--show-toplevel") {
                return Ok(self.repo_root.clone());
            }
            Ok(String::new())
        }
    }

    #[derive(Default)]
    struct MapResolver {
        repos: HashMap<String, RepoInfo>,
        hashes: RefCell<HashMap<String, String>>,
    }
    impl RepoResolver for MapResolver {
        fn repo_info(&self, path: &str) -> Option<RepoInfo> {
            self.repos.get(path).cloned()
        }
        fn hash_file(&self, path: &str) -> std::result::Result<String, String> {
            self.hashes
                .borrow()
                .get(path)
                .cloned()
                .ok_or_else(|| "no hash".into())
        }
    }

    #[test]
    fn errors_when_no_vibe_files() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let git = FakeGit {
            repo_root: repo.to_str().unwrap().to_string(),
        };
        let resolver = MapResolver::default();
        assert!(verify_command(&io, &git, &resolver, V, OutputOptions::default()).is_err());
    }

    #[test]
    fn reports_trusted_when_hash_matches() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let vibe = fx.write("repo/.vibe.toml", "ok = true\n");
        let vibe_str = vibe.to_str().unwrap().to_string();
        let content_hash = hash_content(b"ok = true\n");

        // Trust the file at its current hash.
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let mut settings = VibeSettings::default_settings();
        settings.permissions.allow.push(AllowEntry {
            repo_id: RepoId {
                remote_url: None,
                repo_root: Some(repo.to_str().unwrap().into()),
            },
            relative_path: ".vibe.toml".into(),
            hashes: vec![content_hash],
            skip_hash_check: None,
        });
        save_user_settings(&io, &settings, V).unwrap();

        let mut repos = HashMap::new();
        repos.insert(
            vibe_str.clone(),
            RepoInfo {
                remote_url: None,
                repo_root: repo.to_str().unwrap().into(),
                relative_path: ".vibe.toml".into(),
            },
        );
        let resolver = MapResolver {
            repos,
            hashes: RefCell::new(HashMap::new()),
        };

        let git = FakeGit {
            repo_root: repo.to_str().unwrap().to_string(),
        };
        verify_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap();

        let text = io.stderr_text();
        assert!(text.contains("✅ TRUSTED"), "got: {text}");
        assert!(text.contains("Hash History (1 stored)"));
        assert!(text.contains("(current)"));
    }

    #[test]
    fn reports_not_trusted_when_no_entry() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let vibe = fx.write("repo/.vibe.toml", "x\n");
        let vibe_str = vibe.to_str().unwrap().to_string();

        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let mut repos = HashMap::new();
        repos.insert(
            vibe_str,
            RepoInfo {
                remote_url: Some("github.com/u/r".into()),
                repo_root: repo.to_str().unwrap().into(),
                relative_path: ".vibe.toml".into(),
            },
        );
        let resolver = MapResolver {
            repos,
            hashes: RefCell::new(HashMap::new()),
        };
        let git = FakeGit {
            repo_root: repo.to_str().unwrap().to_string(),
        };
        verify_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap();
        assert!(io.stderr_text().contains("⚠️  NOT TRUSTED"));
    }

    /// Trust an allow entry at `repo` for `.vibe.toml` with the given `hashes`
    /// and optional `skip`, persist it, and register repo info for the file.
    /// Returns a ready `(io, git, resolver)` plus the file path string.
    struct Scenario {
        io: FakeIo,
        git: FakeGit,
        resolver: MapResolver,
    }

    /// Build a single-`.vibe.toml` scenario, optionally trusting it.
    ///
    /// `trust_hashes`: when `Some`, an allow entry is written with those hashes.
    /// `entry_skip` / `global_skip`: set path-level / global `skipHashCheck`.
    /// `remote_url`: the repo's remote (None → `(local)` rendering).
    #[allow(clippy::too_many_arguments)]
    fn scenario(
        fx: &Fixture,
        content: &str,
        trust_hashes: Option<&[&str]>,
        entry_skip: Option<bool>,
        global_skip: Option<bool>,
        remote_url: Option<&str>,
    ) -> (Scenario, String) {
        let repo = fx.mkdir("repo");
        let vibe = fx.write("repo/.vibe.toml", content);
        let vibe_str = vibe.to_str().unwrap().to_string();
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());

        let mut settings = VibeSettings::default_settings();
        settings.skip_hash_check = global_skip;
        if let Some(hashes) = trust_hashes {
            settings.permissions.allow.push(AllowEntry {
                repo_id: RepoId {
                    remote_url: remote_url.map(|s| s.to_string()),
                    repo_root: Some(repo.to_str().unwrap().into()),
                },
                relative_path: ".vibe.toml".into(),
                hashes: hashes.iter().map(|s| s.to_string()).collect(),
                skip_hash_check: entry_skip,
            });
        }
        save_user_settings(&io, &settings, V).unwrap();

        let mut repos = HashMap::new();
        repos.insert(
            vibe_str.clone(),
            RepoInfo {
                remote_url: remote_url.map(|s| s.to_string()),
                repo_root: repo.to_str().unwrap().into(),
                relative_path: ".vibe.toml".into(),
            },
        );
        let scenario = Scenario {
            io,
            git: FakeGit {
                repo_root: repo.to_str().unwrap().to_string(),
            },
            resolver: MapResolver {
                repos,
                hashes: RefCell::new(HashMap::new()),
            },
        };
        (scenario, vibe_str)
    }

    #[test]
    fn reports_hash_mismatch_when_current_hash_not_in_history() {
        // Trust a STALE hash; the file's real hash won't be in the history.
        let fx = Fixture::new();
        let (s, _) = scenario(&fx, "x = 1\n", Some(&["stale-hash"]), None, None, None);
        verify_command(&s.io, &s.git, &s.resolver, V, OutputOptions::default()).unwrap();
        let text = s.io.stderr_text();
        assert!(text.contains("❌ HASH MISMATCH"), "got: {text}");
        assert!(text.contains("does NOT match any stored hash"));
        assert!(text.contains("Action: Run 'vibe trust' to update hash"));
    }

    #[test]
    fn reports_trusted_hash_disabled_for_path_level_skip() {
        let fx = Fixture::new();
        // Path-level skip=true, with a stale hash (skip wins regardless).
        let (s, _) = scenario(&fx, "x\n", Some(&["stale"]), Some(true), None, None);
        verify_command(&s.io, &s.git, &s.resolver, V, OutputOptions::default()).unwrap();
        let text = s.io.stderr_text();
        assert!(
            text.contains("⚠️  TRUSTED (hash check disabled)"),
            "got: {text}"
        );
        assert!(text.contains("Skip Hash Check: true (path-level or global)"));
        // Path-level value is also echoed at the end of the block.
        assert!(text.contains("Path-level Skip Hash Check: true"));
    }

    #[test]
    fn reports_trusted_hash_disabled_for_global_skip() {
        let fx = Fixture::new();
        // Global skip=true, no per-entry override, stale hash.
        let (s, _) = scenario(&fx, "x\n", Some(&["stale"]), None, Some(true), None);
        verify_command(&s.io, &s.git, &s.resolver, V, OutputOptions::default()).unwrap();
        let text = s.io.stderr_text();
        assert!(
            text.contains("⚠️  TRUSTED (hash check disabled)"),
            "got: {text}"
        );
        // Global true is reflected in the trailing global-settings line too.
        assert!(text.contains("Skip Hash Check: true"));
    }

    #[test]
    fn global_skip_hash_check_line_reflects_true_and_false() {
        // false (default global) → trailing "Skip Hash Check: false".
        let fx = Fixture::new();
        let (s, _) = scenario(&fx, "x\n", None, None, Some(false), None);
        verify_command(&s.io, &s.git, &s.resolver, V, OutputOptions::default()).unwrap();
        assert!(s.io.stderr_text().contains("=== Global Settings ==="));
        assert!(s.io.stderr_text().contains("Skip Hash Check: false"));

        // true → trailing "Skip Hash Check: true".
        let fx2 = Fixture::new();
        let (s2, _) = scenario(&fx2, "x\n", None, None, Some(true), None);
        verify_command(&s2.io, &s2.git, &s2.resolver, V, OutputOptions::default()).unwrap();
        assert!(s2.io.stderr_text().contains("Skip Hash Check: true"));
    }

    #[test]
    fn renders_both_vibe_toml_and_local_toml_with_blank_separator() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let vibe = fx.write("repo/.vibe.toml", "a\n");
        let local = fx.write("repo/.vibe.local.toml", "b\n");
        let vibe_str = vibe.to_str().unwrap().to_string();
        let local_str = local.to_str().unwrap().to_string();

        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        save_user_settings(&io, &VibeSettings::default_settings(), V).unwrap();

        let mut repos = HashMap::new();
        for (p, rel) in [(&vibe_str, ".vibe.toml"), (&local_str, ".vibe.local.toml")] {
            repos.insert(
                p.clone(),
                RepoInfo {
                    remote_url: None,
                    repo_root: repo.to_str().unwrap().into(),
                    relative_path: rel.into(),
                },
            );
        }
        let resolver = MapResolver {
            repos,
            hashes: RefCell::new(HashMap::new()),
        };
        let git = FakeGit {
            repo_root: repo.to_str().unwrap().to_string(),
        };
        verify_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap();

        let lines = io.stderr.borrow().clone();
        // Both file blocks are present.
        assert!(lines.iter().any(|l| l == "File: .vibe.toml"));
        assert!(lines.iter().any(|l| l == "File: .vibe.local.toml"));
        // A blank line separates the two blocks: the line right before the second
        // "File:" header is empty.
        let local_idx = lines
            .iter()
            .position(|l| l == "File: .vibe.local.toml")
            .unwrap();
        assert!(
            local_idx > 0 && lines[local_idx - 1].is_empty(),
            "missing blank separator"
        );
    }

    #[test]
    fn multiple_hash_history_marks_current_with_arrow_and_numbers() {
        let fx = Fixture::new();
        // Trust two hashes: a stale one, then the file's actual current hash.
        let current = hash_content(b"x\n");
        let (s, _) = scenario(
            &fx,
            "x\n",
            Some(&["0000000000000000aaaa", &current]),
            None,
            None,
            None,
        );
        verify_command(&s.io, &s.git, &s.resolver, V, OutputOptions::default()).unwrap();
        let text = s.io.stderr_text();
        assert!(text.contains("Hash History (2 stored)"), "got: {text}");
        // Entry 1 is the stale hash: plain (space) marker, numbered 1, no
        // "(current)" suffix.
        assert!(
            text.contains("  1. 0000000000000000..."),
            "expected plain entry 1; got: {text}"
        );
        // Entry 2 is the current hash: arrow marker, numbered 2, " (current)"
        // suffix (note the leading space in the suffix, per the format string).
        let current_prefix = &current[..current.len().min(16)];
        assert!(
            text.contains(&format!("→ 2. {current_prefix}... (current)")),
            "expected arrow+current on entry 2; got: {text}"
        );
    }

    #[test]
    fn reports_not_in_git_repository_when_repo_info_none() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let _ = fx.write("repo/.vibe.toml", "x\n");
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        save_user_settings(&io, &VibeSettings::default_settings(), V).unwrap();
        // Resolver returns None for the file → "NOT IN GIT REPOSITORY".
        let resolver = MapResolver::default();
        let git = FakeGit {
            repo_root: repo.to_str().unwrap().to_string(),
        };
        verify_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap();
        let text = io.stderr_text();
        assert!(text.contains("❌ NOT IN GIT REPOSITORY"), "got: {text}");
        assert!(text.contains("Action: File must be in a git repository to be trusted"));
    }

    #[test]
    fn unreadable_file_reports_cannot_read_and_still_exits_ok() {
        // Characterization test: locks the intentional TS behavior that a file
        // unreadable AFTER the exists() check prints an error line but verify
        // still returns Ok (display-only, no propagation). We model "unreadable"
        // by trusting a path whose file is removed between exists() and hash —
        // here we point the allow entry + repo_info at a path that exists for the
        // exists() check (the real .vibe.toml) but make hash_file fail by removing
        // it after the exists() check is not possible mid-call; instead we trust a
        // DIRECTORY as the file so the content hash read fails while exists()==true.
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        // Create `.vibe.toml` as a DIRECTORY: exists() is true, hash_file (a read)
        // fails with EISDIR, hitting the "Cannot read file" branch.
        let vibe_dir = fx.mkdir("repo/.vibe.toml");
        let vibe_str = vibe_dir.to_str().unwrap().to_string();
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());

        let mut settings = VibeSettings::default_settings();
        settings.permissions.allow.push(AllowEntry {
            repo_id: RepoId {
                remote_url: None,
                repo_root: Some(repo.to_str().unwrap().into()),
            },
            relative_path: ".vibe.toml".into(),
            hashes: vec!["whatever".into()],
            skip_hash_check: None,
        });
        save_user_settings(&io, &settings, V).unwrap();

        let mut repos = HashMap::new();
        repos.insert(
            vibe_str,
            RepoInfo {
                remote_url: None,
                repo_root: repo.to_str().unwrap().into(),
                relative_path: ".vibe.toml".into(),
            },
        );
        let resolver = MapResolver {
            repos,
            hashes: RefCell::new(HashMap::new()),
        };
        let git = FakeGit {
            repo_root: repo.to_str().unwrap().to_string(),
        };
        // Exits Ok despite the unreadable file (TOCTOU/display-only behavior).
        let outcome = verify_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::none());
        assert!(
            io.stderr_text().contains("❌ ERROR - Cannot read file"),
            "got: {}",
            io.stderr_text()
        );
    }

    #[test]
    fn repository_line_shows_local_root_when_no_remote_url() {
        let fx = Fixture::new();
        let (s, _) = scenario(&fx, "x\n", None, None, None, None);
        verify_command(&s.io, &s.git, &s.resolver, V, OutputOptions::default()).unwrap();
        let text = s.io.stderr_text();
        // No remote URL → "Repository: (local) <root>".
        assert!(text.contains("Repository: (local) "), "got: {text}");
        assert!(!text.contains("Repository: github.com"));
    }

    #[test]
    fn repository_line_shows_remote_url_when_present() {
        let fx = Fixture::new();
        let (s, _) = scenario(&fx, "x\n", None, None, None, Some("github.com/u/r"));
        verify_command(&s.io, &s.git, &s.resolver, V, OutputOptions::default()).unwrap();
        let text = s.io.stderr_text();
        assert!(text.contains("Repository: github.com/u/r"), "got: {text}");
        assert!(!text.contains("(local)"));
    }
}
