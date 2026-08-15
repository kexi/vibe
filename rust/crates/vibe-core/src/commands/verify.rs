//! `vibe verify`: report trust status and hash history for the repo's config.
//!
//! Ported from `packages/core/src/commands/verify.ts`. Reads `.vibe.toml` and
//! `.vibe.local.toml` at the repo root, and for each prints repository identity,
//! a trust status line (trusted / not-trusted / hash-mismatch / skip), and the
//! stored hash history. Every line is reproduced to match the TS exactly,
//! including the emoji markers. No `cd` is produced.
//!
//! Divergence from the TS (issue #599 follow-up): a status block also reports
//! when a file is hash-trusted but its trust predates
//! `config::CONFIG_SEMANTICS_REV` AND it uses a position that revision made
//! effective. Without it `verify` would print `✅ TRUSTED` and exit 0 for
//! exactly the configs `start`/`clean`/`rename` hard-fail on — and `verify` is
//! the command a user reaches for to diagnose that failure. The verdict comes
//! from `config_loader::newly_effective_fields`, the same predicate the loader
//! fails closed on, so the diagnostic cannot drift from the error.

use crate::commands::Outcome;
use crate::config::{parse_vibe_config, RawConfig, CONFIG_SEMANTICS_REV};
use crate::config_loader::{newly_effective_fields, ConfigRole, VIBE_LOCAL_TOML, VIBE_TOML};
use crate::error::{Result, VibeError};
use crate::git::{get_repo_root, GitRunner};
use crate::hash::hash_content;
use crate::io::Io;
use crate::output::{error_log, log, success_log, warn_log, OutputOptions};
use crate::settings::RepoResolver;
use crate::settings::{find_matching_entry, should_skip_hash_check, AllowEntry, VibeSettings};
use crate::settings_io::load_user_settings;
use std::path::Path;

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

    // Which positions became newly effective depends on how many config files
    // the repo has, so mirror the loader's own case split.
    let both = vibe_exists && local_exists;

    if vibe_exists {
        display_file_status(
            io,
            resolver,
            &settings,
            vibe_toml_path.to_str().unwrap_or_default(),
            VIBE_TOML,
            if both {
                ConfigRole::BaseOfPair
            } else {
                ConfigRole::Single
            },
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
            if both {
                ConfigRole::LocalOfPair
            } else {
                ConfigRole::Single
            },
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
    role: ConfigRole,
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

    // Read once and derive both the hash and the semantics check from those
    // bytes, so the two verdicts in one status block always describe the same
    // file content (the same single-read discipline as `verify_trust_and_read`).
    let content = match std::fs::read(file_path) {
        Ok(c) => c,
        Err(e) => {
            error_log(
                io,
                &format!(
                    "Status: ❌ ERROR - Cannot read file: Failed to read \"{file_path}\": {e}"
                ),
            );
            return;
        }
    };
    let current_hash = hash_content(&content);

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

    display_semantics_status(io, entry, &current_hash, &content, file_path, role, opts);

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

/// Report a trust grant that predates the current config-interpretation
/// revision, and whether the file actually relies on the positions that
/// revision activated.
///
/// Always echoes the stored revision (a plain fact about the entry, free of any
/// parsing), and additionally warns when the loader will refuse this file. Why
/// only warn rather than fail: `verify` is a read-only diagnostic that reports
/// state and exits 0 — the enforcement point is the loader.
///
/// A file whose bytes do not parse gets the revision line but no verdict: the
/// detectors need a [`RawConfig`], and an unparsable file already fails earlier
/// in every command that loads it, so there is no "trusted but will fail on
/// semantics" surprise left to warn about.
fn display_semantics_status(
    io: &impl Io,
    entry: &AllowEntry,
    current_hash: &str,
    content: &[u8],
    file_path: &str,
    role: ConfigRole,
    opts: OutputOptions,
) {
    // The revision for the bytes ON DISK, matching what the loader will consult;
    // reading the entry-wide stamp instead would report "current" for a file
    // whose own hash was approved under an older revision and still be rejected.
    let rev = entry.semantics_rev_for(current_hash);
    if rev >= CONFIG_SEMANTICS_REV {
        return;
    }
    log(
        io,
        &format!("Config Semantics: trusted at revision {rev} (current: {CONFIG_SEMANTICS_REV})"),
        opts,
    );

    let Ok(text) = std::str::from_utf8(content) else {
        return;
    };
    let Ok(config): Result<RawConfig> = parse_vibe_config(text, file_path) else {
        return;
    };
    let fields = newly_effective_fields(&config, role);
    if fields.is_empty() {
        return;
    }

    warn_log(io, "Status: ⚠️  STALE CONFIG SEMANTICS");
    warn_log(
        io,
        &format!(
            "These fields were accepted but ignored when this file was trusted and now take effect: {}",
            fields.join(", ")
        ),
    );
    warn_log(
        io,
        "Action: Review the file, then re-approve it with 'vibe trust' (other commands will refuse it until then)",
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::RepoInfo;
    use crate::io::FakeIo;
    use crate::settings::RepoId;
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
            config_semantics_rev: None,
            config_semantics_revs: None,
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
                config_semantics_rev: None,
                config_semantics_revs: None,
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
            config_semantics_rev: None,
            config_semantics_revs: None,
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

    // --- config-semantics revision reporting (issue #599 follow-up) ---

    /// A lone `.vibe.toml` using a newly-effective position under a pre-#599
    /// trust is NOT reported as plainly trusted: `verify` names the offending
    /// fields, so it agrees with the hard failure `start`/`clean` will produce.
    #[test]
    fn warns_when_pre_599_trust_meets_newly_effective_fields() {
        let fx = Fixture::new();
        let content = "[hooks]\npost_start_append = [\"echo hi\"]\n";
        let hash = hash_content(content.as_bytes());
        let (s, _) = scenario(&fx, content, Some(&[&hash]), None, None, None);
        verify_command(&s.io, &s.git, &s.resolver, V, OutputOptions::default()).unwrap();

        let text = s.io.stderr_text();
        assert!(text.contains("✅ TRUSTED"), "got: {text}");
        assert!(
            text.contains("Config Semantics: trusted at revision 0"),
            "got: {text}"
        );
        assert!(text.contains("⚠️  STALE CONFIG SEMANTICS"), "got: {text}");
        assert!(text.contains("hooks.post_start_append"), "got: {text}");
        assert!(
            text.contains("re-approve it with 'vibe trust'"),
            "got: {text}"
        );
    }

    /// A pre-#599 trust over a config that uses none of the newly-effective
    /// positions still reports its stored revision, but raises no warning: its
    /// meaning did not change, and the loader will accept it.
    #[test]
    fn reports_revision_without_warning_when_no_field_became_effective() {
        let fx = Fixture::new();
        let content = "[hooks]\npost_start = [\"echo hi\"]\n";
        let hash = hash_content(content.as_bytes());
        let (s, _) = scenario(&fx, content, Some(&[&hash]), None, None, None);
        verify_command(&s.io, &s.git, &s.resolver, V, OutputOptions::default()).unwrap();

        let text = s.io.stderr_text();
        assert!(
            text.contains("Config Semantics: trusted at revision 0"),
            "got: {text}"
        );
        assert!(!text.contains("STALE CONFIG SEMANTICS"), "got: {text}");
    }

    /// A trust granted at the current revision says nothing about semantics at
    /// all — the status block is unchanged for everyone who re-trusted.
    #[test]
    fn stays_silent_when_trust_is_at_the_current_revision() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let content = "[hooks]\npost_start_append = [\"echo hi\"]\n";
        let vibe = fx.write("repo/.vibe.toml", content);
        let vibe_str = vibe.to_str().unwrap().to_string();

        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let mut settings = VibeSettings::default_settings();
        settings.permissions.allow.push(AllowEntry {
            repo_id: RepoId {
                remote_url: None,
                repo_root: Some(repo.to_str().unwrap().into()),
            },
            relative_path: ".vibe.toml".into(),
            hashes: vec![hash_content(content.as_bytes())],
            skip_hash_check: None,
            config_semantics_rev: Some(CONFIG_SEMANTICS_REV),
            config_semantics_revs: None,
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
        verify_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap();

        let text = io.stderr_text();
        assert!(text.contains("✅ TRUSTED"), "got: {text}");
        assert!(!text.contains("Config Semantics:"), "got: {text}");
        assert!(!text.contains("STALE CONFIG SEMANTICS"), "got: {text}");
    }

    /// With BOTH config files present, the local file's extension is only
    /// newly-effective when it sits beside its own base field — the same case
    /// split the loader applies, so verify never over-warns.
    #[test]
    fn applies_the_two_file_role_split_to_the_local_file() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        // Base: plain, nothing became effective.
        let base_content = "[hooks]\npost_start = [\"base\"]\n";
        // Local: an append with NO `post_start` beside it → always was effective.
        let local_content = "[hooks]\npost_start_append = [\"local\"]\n";
        let base = fx.write("repo/.vibe.toml", base_content);
        let local = fx.write("repo/.vibe.local.toml", local_content);

        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let mut settings = VibeSettings::default_settings();
        let mut repos = HashMap::new();
        for (path, rel, content) in [
            (&base, ".vibe.toml", base_content),
            (&local, ".vibe.local.toml", local_content),
        ] {
            let path_str = path.to_str().unwrap().to_string();
            settings.permissions.allow.push(AllowEntry {
                repo_id: RepoId {
                    remote_url: None,
                    repo_root: Some(repo.to_str().unwrap().into()),
                },
                relative_path: rel.into(),
                hashes: vec![hash_content(content.as_bytes())],
                skip_hash_check: None,
                config_semantics_rev: None, // pre-#599 trust
                config_semantics_revs: None,
            });
            repos.insert(
                path_str,
                RepoInfo {
                    remote_url: None,
                    repo_root: repo.to_str().unwrap().into(),
                    relative_path: rel.into(),
                },
            );
        }
        save_user_settings(&io, &settings, V).unwrap();

        let resolver = MapResolver {
            repos,
            hashes: RefCell::new(HashMap::new()),
        };
        let git = FakeGit {
            repo_root: repo.to_str().unwrap().to_string(),
        };
        verify_command(&io, &git, &resolver, V, OutputOptions::default()).unwrap();

        // Neither file changed meaning, so no warning despite revision-0 trust.
        let text = io.stderr_text();
        assert!(
            text.contains("Config Semantics: trusted at revision 0"),
            "got: {text}"
        );
        assert!(!text.contains("STALE CONFIG SEMANTICS"), "got: {text}");
    }

    /// An unparsable-but-trusted file gets the revision line and no verdict:
    /// the detectors need a parsed config, and the parse error surfaces from
    /// every command that actually loads it.
    #[test]
    fn skips_the_semantics_verdict_for_an_unparsable_file() {
        let fx = Fixture::new();
        let content = "this is not toml\n";
        let hash = hash_content(content.as_bytes());
        let (s, _) = scenario(&fx, content, Some(&[&hash]), None, None, None);
        verify_command(&s.io, &s.git, &s.resolver, V, OutputOptions::default()).unwrap();

        let text = s.io.stderr_text();
        assert!(
            text.contains("Config Semantics: trusted at revision 0"),
            "got: {text}"
        );
        assert!(!text.contains("STALE CONFIG SEMANTICS"), "got: {text}");
    }
}
