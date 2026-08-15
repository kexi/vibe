//! `.vibe.toml` / `.vibe.local.toml` config types, parsing and merging.
//!
//! Ported from `packages/core/src/types/config.ts` (the Zod schema) and the
//! merge logic in `packages/core/src/utils/config.ts`. serde's
//! `deny_unknown_fields` reproduces Zod's `.strict()`, and concurrency range
//! validation (1-32) is applied after deserialization. The trust-gated *loader*
//! lives with the settings/trust code; this module is pure (types + merge) so it
//! is unit-testable without filesystem or trust state.
//!
//! Divergence from the TS merge logic (issue #599): a file's own
//! `*_prepend`/`*_append` fields are effective in EVERY load path, not just for
//! `.vibe.local.toml` in a repo that happens to have both config files. The TS
//! `mergeArrayField` returned an explicit override outright, so extensions given
//! alongside it were silently dropped; here they wrap whichever of
//! override/base survives. [`normalize_config`] applies that within-file rule to
//! a single file so the single-file and two-file loaders share one
//! implementation of the array algebra.
//!
//! Because that divergence turns previously-inert fields into executable
//! configuration, `CONFIG_SEMANTICS_REV` versions the interpretation itself
//! and the loader refuses to run a config that relies on the new positions
//! under a trust grant issued before the change.

use crate::error::{Result, VibeError};
use serde::{Deserialize, Serialize};

/// Revision of the `.vibe.toml` INTERPRETATION rules.
///
/// Bumped whenever a change makes previously-parsed-but-ignored config
/// positions take effect. Trust entries record the revision they were granted
/// under (see `AllowEntry::config_semantics_rev`); an entry without one is
/// revision 0, i.e. trust granted before issue #599 made `*_prepend`/`*_append`
/// effective in every load path.
///
/// Why not rely on the content hash alone: the SHA-256 trust hash covers the
/// file's BYTES, not how vibe interprets them. Upgrading the binary would
/// otherwise silently activate hook entries the user trusted while they were
/// inert, with no re-trust prompt.
///
/// Crate-internal: the revision is an implementation detail of the trust guard,
/// not part of the library surface, and keeping it so means the guard's
/// consumers can be enumerated.
pub(crate) const CONFIG_SEMANTICS_REV: u32 = 1;

/// Parsed `.vibe.toml` config. Every section is optional.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VibeConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy: Option<CopyConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hooks: Option<HooksConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clean: Option<CleanConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submodules: Option<SubmodulesConfig>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CopyConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_prepend: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_append: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirs_prepend: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirs_append: Option<Vec<String>>,
    /// Directories SHARED with the origin worktree via a symlink instead of
    /// being copied. Takes precedence over a `files`/`dirs` entry naming the
    /// same path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symlink: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symlink_prepend: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symlink_append: Option<Vec<String>>,
    /// Parallel directory-copy operations (1-32, default 4 applied at use site).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<i64>,
    /// Also copy untracked, non-ignored files (`git ls-files --others
    /// --exclude-standard`). Opt-in; `None` means off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub untracked: Option<bool>,
    /// Also copy locally modified tracked files (`git ls-files --modified`).
    /// Opt-in; `None` means off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HooksConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_start: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_start_prepend: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_start_append: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_start: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_start_prepend: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_start_append: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_clean: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_clean_prepend: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_clean_append: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_clean: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_clean_prepend: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_clean_append: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorktreeConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_script: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CleanConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete_branch: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubmodulesConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configs: Option<Vec<String>>,
}

/// A config exactly as it was written on disk, before [`normalize_config`]
/// folds each `*_prepend`/`*_append` slot into its base field.
///
/// Exists so the semantics-revision guard cannot be handed an already-normalized
/// config: the detectors it relies on
/// (`config_loader::newly_effective_fields`) inspect the very slots
/// normalization empties, so a normalized input would report "no newly-effective
/// fields" and fail OPEN. Only [`parse_vibe_config`] mints one, so the raw
/// provenance the guard depends on is expressed in the type rather than in prose.
#[derive(Debug, Clone, PartialEq)]
pub struct RawConfig(VibeConfig);

impl RawConfig {
    /// Borrow the un-normalized config.
    ///
    /// Needed by the cross-file merge, which must see the local file's extension
    /// slots UNFOLDED so they wrap the base's effective arrays instead of
    /// overriding them. Not a general escape hatch: the guard's detectors take
    /// `&RawConfig` precisely so they can never be reached this way.
    pub(crate) fn as_config(&self) -> &VibeConfig {
        &self.0
    }

    /// Resolve this file's own `*_prepend`/`*_append` fields, consuming the
    /// raw-ness: the result is a plain [`VibeConfig`] and no longer admissible
    /// to the guard.
    pub(crate) fn normalize(&self) -> VibeConfig {
        normalize_config(&self.0)
    }
}

/// Parse a [`RawConfig`] from TOML text, validating it like the Zod schema.
///
/// `file_path` is woven into the error message exactly as the TS
/// `parseVibeConfig` does (`Invalid configuration in <path>: ...`).
pub fn parse_vibe_config(toml_text: &str, file_path: &str) -> Result<RawConfig> {
    let config: VibeConfig = toml::from_str(toml_text).map_err(|e| {
        VibeError::Configuration(format!("Invalid configuration in {file_path}:\n  - {e}"))
    })?;

    // Concurrency range check (Zod `.int().min(1).max(32)`).
    if let Some(c) = config.copy.as_ref().and_then(|c| c.concurrency) {
        if !(1..=32).contains(&c) {
            return Err(VibeError::Configuration(format!(
                "Invalid configuration in {file_path}:\n  - copy.concurrency: must be between 1 and 32"
            )));
        }
    }

    Ok(RawConfig(config))
}

/// Merge a base array with override/prepend/append.
///
/// Precedence: an explicit `override` REPLACES the base, then the same source's
/// prepend/append wrap whichever of override/base survives — the result is
/// `prepend ++ (override | base) ++ append`. With neither override nor base
/// present, prepend+append concatenate (only if either is present), else `None`;
/// an empty override array with no extensions still yields `Some(vec![])`.
///
/// Why not keep the TS `mergeArrayField` precedence (return the override
/// outright): it silently dropped prepend/append supplied alongside an override,
/// which is the bug class of issue #599 — a schema-accepted field with no
/// effect. This port intentionally diverges so every accepted field is honored.
pub fn merge_array_field(
    base: Option<&[String]>,
    override_: Option<&[String]>,
    prepend: Option<&[String]>,
    append: Option<&[String]>,
) -> Option<Vec<String>> {
    let effective_base = override_.or(base);

    if effective_base.is_none() && prepend.is_none() && append.is_none() {
        return None;
    }

    let mut out = Vec::new();
    out.extend(prepend.unwrap_or_default().iter().cloned());
    out.extend(effective_base.unwrap_or_default().iter().cloned());
    out.extend(append.unwrap_or_default().iter().cloned());
    Some(out)
}

/// Merge a base config with a local override config, matching `mergeConfigs`.
pub fn merge_configs(base: &VibeConfig, local: &VibeConfig) -> VibeConfig {
    let mut merged = VibeConfig::default();

    // copy.files / copy.dirs via merge_array_field; concurrency: local > base.
    let merged_files = merge_array_field(
        deref(&base.copy, |c| &c.files),
        deref(&local.copy, |c| &c.files),
        deref(&local.copy, |c| &c.files_prepend),
        deref(&local.copy, |c| &c.files_append),
    );
    let merged_dirs = merge_array_field(
        deref(&base.copy, |c| &c.dirs),
        deref(&local.copy, |c| &c.dirs),
        deref(&local.copy, |c| &c.dirs_prepend),
        deref(&local.copy, |c| &c.dirs_append),
    );
    let merged_symlink = merge_array_field(
        deref(&base.copy, |c| &c.symlink),
        deref(&local.copy, |c| &c.symlink),
        deref(&local.copy, |c| &c.symlink_prepend),
        deref(&local.copy, |c| &c.symlink_append),
    );
    let concurrency = local
        .copy
        .as_ref()
        .and_then(|c| c.concurrency)
        .or_else(|| base.copy.as_ref().and_then(|c| c.concurrency));
    // Scalar toggles: local wins when set, otherwise the base value carries.
    let untracked = local
        .copy
        .as_ref()
        .and_then(|c| c.untracked)
        .or_else(|| base.copy.as_ref().and_then(|c| c.untracked));
    let modified = local
        .copy
        .as_ref()
        .and_then(|c| c.modified)
        .or_else(|| base.copy.as_ref().and_then(|c| c.modified));

    if merged_files.is_some()
        || merged_dirs.is_some()
        || merged_symlink.is_some()
        || concurrency.is_some()
        || untracked.is_some()
        || modified.is_some()
    {
        merged.copy = Some(CopyConfig {
            files: merged_files,
            dirs: merged_dirs,
            symlink: merged_symlink,
            concurrency,
            untracked,
            modified,
            ..CopyConfig::default()
        });
    }

    // hooks: each of the four lifecycle arrays merged independently.
    let mut hooks = HooksConfig::default();
    let mut any_hook = false;
    macro_rules! merge_hook {
        ($field:ident, $prepend:ident, $append:ident) => {{
            let m = merge_array_field(
                deref(&base.hooks, |h| &h.$field),
                deref(&local.hooks, |h| &h.$field),
                deref(&local.hooks, |h| &h.$prepend),
                deref(&local.hooks, |h| &h.$append),
            );
            if let Some(v) = m {
                hooks.$field = Some(v);
                any_hook = true;
            }
        }};
    }
    merge_hook!(pre_start, pre_start_prepend, pre_start_append);
    merge_hook!(post_start, post_start_prepend, post_start_append);
    merge_hook!(pre_clean, pre_clean_prepend, pre_clean_append);
    merge_hook!(post_clean, post_clean_prepend, post_clean_append);
    if any_hook {
        merged.hooks = Some(hooks);
    }

    // worktree: present if either side has it; path_script local > base.
    if base.worktree.is_some() || local.worktree.is_some() {
        let path_script = local
            .worktree
            .as_ref()
            .and_then(|w| w.path_script.clone())
            .or_else(|| base.worktree.as_ref().and_then(|w| w.path_script.clone()));
        merged.worktree = Some(WorktreeConfig { path_script });
    }

    // clean: present if either side has it; delete_branch local > base.
    // Why not match the TS `mergeConfigs`: the TS version omitted the clean
    // section entirely, silently dropping `[clean] delete_branch` whenever a
    // `.vibe.local.toml` coexisted with `.vibe.toml` (the only path through this
    // function). That was a latent bug, not intended behavior — `clean` is
    // merged here so `delete_branch` survives the two-file case.
    if base.clean.is_some() || local.clean.is_some() {
        let delete_branch = local
            .clean
            .as_ref()
            .and_then(|c| c.delete_branch)
            .or_else(|| base.clean.as_ref().and_then(|c| c.delete_branch));
        merged.clean = Some(CleanConfig { delete_branch });
    }

    // submodules: present if either side has it; configs local > base.
    if base.submodules.is_some() || local.submodules.is_some() {
        let configs = local
            .submodules
            .as_ref()
            .and_then(|s| s.configs.clone())
            .or_else(|| base.submodules.as_ref().and_then(|s| s.configs.clone()));
        merged.submodules = Some(SubmodulesConfig { configs });
    }

    merged
}

/// Resolve a single file's own `*_prepend`/`*_append` fields into effective
/// arrays (`prepend ++ field ++ append` per field).
///
/// Implemented as a merge over the empty config so single-file and two-file
/// loading share ONE implementation of the array semantics (issue #599).
pub fn normalize_config(config: &VibeConfig) -> VibeConfig {
    merge_configs(&VibeConfig::default(), config)
}

/// Every `(field, prepend, append)` triplet of a raw (un-normalized) config,
/// as `(dotted name, field set?, prepend set?, append set?)`.
///
/// Drives the semantics-revision guard in the loader: it must reason about the
/// raw slots, which [`normalize_config`] folds away.
fn extension_triplets(config: &VibeConfig) -> Vec<(&'static str, bool, bool, bool)> {
    let mut out = Vec::new();
    macro_rules! triplet {
        ($name:literal, $section:expr, $field:ident, $prepend:ident, $append:ident) => {{
            let s = $section.as_ref();
            out.push((
                $name,
                s.is_some_and(|x| x.$field.is_some()),
                s.is_some_and(|x| x.$prepend.is_some()),
                s.is_some_and(|x| x.$append.is_some()),
            ));
        }};
    }
    triplet!(
        "copy.files",
        config.copy,
        files,
        files_prepend,
        files_append
    );
    triplet!("copy.dirs", config.copy, dirs, dirs_prepend, dirs_append);
    triplet!(
        "copy.symlink",
        config.copy,
        symlink,
        symlink_prepend,
        symlink_append
    );
    triplet!(
        "hooks.pre_start",
        config.hooks,
        pre_start,
        pre_start_prepend,
        pre_start_append
    );
    triplet!(
        "hooks.post_start",
        config.hooks,
        post_start,
        post_start_prepend,
        post_start_append
    );
    triplet!(
        "hooks.pre_clean",
        config.hooks,
        pre_clean,
        pre_clean_prepend,
        pre_clean_append
    );
    triplet!(
        "hooks.post_clean",
        config.hooks,
        post_clean,
        post_clean_prepend,
        post_clean_append
    );
    out
}

/// Dotted names of the `*_prepend`/`*_append` fields set in a raw config.
///
/// Takes [`RawConfig`], not `&VibeConfig`: on a normalized config every slot is
/// already folded to `None` and this would answer "none in use" — a fail-OPEN
/// verdict from a security guard.
pub(crate) fn extension_fields_in_use(config: &RawConfig) -> Vec<String> {
    let mut names = Vec::new();
    for (name, _, prepend, append) in extension_triplets(&config.0) {
        if prepend {
            names.push(format!("{name}_prepend"));
        }
        if append {
            names.push(format!("{name}_append"));
        }
    }
    names
}

/// Dotted names of the `*_prepend`/`*_append` fields a raw config sets ALONGSIDE
/// their own base field (the position the TS `mergeArrayField` dropped even when
/// both config files were present).
///
/// Takes [`RawConfig`] for the same fail-open reason as
/// [`extension_fields_in_use`].
pub(crate) fn extension_fields_beside_own_field(config: &RawConfig) -> Vec<String> {
    let mut names = Vec::new();
    for (name, field, prepend, append) in extension_triplets(&config.0) {
        if !field {
            continue;
        }
        if prepend {
            names.push(format!("{name}_prepend"));
        }
        if append {
            names.push(format!("{name}_append"));
        }
    }
    names
}

/// Helper: project an `Option<Section>` to an inner `Option<Vec<String>>` slice.
fn deref<'a, S>(
    section: &'a Option<S>,
    field: impl Fn(&'a S) -> &'a Option<Vec<String>>,
) -> Option<&'a [String]> {
    section.as_ref().and_then(|s| field(s).as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    // --- merge_array_field ---

    #[test]
    fn override_replaces_base_then_own_prepend_append_wrap() {
        let r = merge_array_field(Some(&v(&["a"])), Some(&v(&["b"])), Some(&v(&["p"])), None);
        assert_eq!(r, Some(v(&["p", "b"])));
    }

    #[test]
    fn override_with_append_combines() {
        let r = merge_array_field(None, Some(&v(&["b"])), None, Some(&v(&["x"])));
        assert_eq!(r, Some(v(&["b", "x"])));
    }

    #[test]
    fn prepend_and_append_with_base() {
        let r = merge_array_field(
            Some(&v(&["base"])),
            None,
            Some(&v(&["pre"])),
            Some(&v(&["post"])),
        );
        assert_eq!(r, Some(v(&["pre", "base", "post"])));
    }

    #[test]
    fn only_prepend_and_only_append() {
        assert_eq!(
            merge_array_field(Some(&v(&["base"])), None, Some(&v(&["pre"])), None),
            Some(v(&["pre", "base"]))
        );
        assert_eq!(
            merge_array_field(Some(&v(&["base"])), None, None, Some(&v(&["post"]))),
            Some(v(&["base", "post"]))
        );
    }

    #[test]
    fn base_only() {
        assert_eq!(
            merge_array_field(Some(&v(&["base"])), None, None, None),
            Some(v(&["base"]))
        );
    }

    #[test]
    fn no_base_with_prepend_and_append() {
        assert_eq!(
            merge_array_field(None, None, Some(&v(&["pre"])), Some(&v(&["post"]))),
            Some(v(&["pre", "post"]))
        );
    }

    #[test]
    fn all_undefined_is_none() {
        assert_eq!(merge_array_field(None, None, None, None), None);
    }

    #[test]
    fn empty_override_array_is_kept() {
        assert_eq!(
            merge_array_field(Some(&v(&["a"])), Some(&[]), None, None),
            Some(vec![])
        );
    }

    #[test]
    fn empty_override_with_append_yields_append() {
        // `files = []` disables the base list, but an append in the SAME source
        // still contributes: the disable idiom does not swallow extensions.
        assert_eq!(
            merge_array_field(Some(&v(&["a"])), Some(&[]), None, Some(&v(&["x"]))),
            Some(v(&["x"]))
        );
    }

    // --- normalize_config ---

    #[test]
    fn normalize_resolves_same_file_prepend_and_append() {
        let cfg = VibeConfig {
            copy: Some(CopyConfig {
                files: Some(v(&[".env"])),
                files_prepend: Some(v(&["p"])),
                files_append: Some(v(&[".env.local"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        let copy = normalize_config(&cfg).copy.unwrap();
        assert_eq!(copy.files, Some(v(&["p", ".env", ".env.local"])));
        // The extension slots are consumed by normalization.
        assert_eq!(copy.files_prepend, None);
        assert_eq!(copy.files_append, None);
    }

    #[test]
    fn normalize_append_only_becomes_the_field() {
        let cfg = VibeConfig {
            copy: Some(CopyConfig {
                files_append: Some(v(&[".env.local"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            normalize_config(&cfg).copy.unwrap().files,
            Some(v(&[".env.local"]))
        );
    }

    #[test]
    fn normalize_resolves_hooks_triplets() {
        let cfg = VibeConfig {
            hooks: Some(HooksConfig {
                post_start: Some(v(&["npm install"])),
                post_start_prepend: Some(v(&["echo pre"])),
                post_start_append: Some(v(&["npm run dev"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        let hooks = normalize_config(&cfg).hooks.unwrap();
        assert_eq!(
            hooks.post_start,
            Some(v(&["echo pre", "npm install", "npm run dev"]))
        );
        assert_eq!(hooks.post_start_prepend, None);
        assert_eq!(hooks.post_start_append, None);
    }

    #[test]
    fn normalize_is_identity_for_plain_config() {
        let cfg = VibeConfig {
            copy: Some(CopyConfig {
                files: Some(v(&[".env"])),
                concurrency: Some(8),
                untracked: Some(true),
                ..Default::default()
            }),
            hooks: Some(HooksConfig {
                pre_start: Some(v(&["echo hi"])),
                ..Default::default()
            }),
            worktree: Some(WorktreeConfig {
                path_script: Some("p.sh".into()),
            }),
            clean: Some(CleanConfig {
                delete_branch: Some(true),
            }),
            submodules: Some(SubmodulesConfig {
                configs: Some(v(&["libs/foo"])),
            }),
        };
        assert_eq!(normalize_config(&cfg), cfg);
    }

    #[test]
    fn normalize_is_idempotent() {
        // Load-bearing: the two-file path normalizes the base and then re-runs the
        // same array algebra inside merge_configs, so normalization must be a
        // fixed point for that composition to be well defined.
        let cfg = VibeConfig {
            copy: Some(CopyConfig {
                files: Some(v(&[".env"])),
                files_prepend: Some(v(&["p"])),
                files_append: Some(v(&["a"])),
                dirs_append: Some(v(&["node_modules"])),
                concurrency: Some(8),
                ..Default::default()
            }),
            hooks: Some(HooksConfig {
                post_start: Some(v(&["npm install"])),
                post_start_append: Some(v(&["npm run dev"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        let once = normalize_config(&cfg);
        assert_eq!(normalize_config(&once), once);
    }

    // --- merge_configs ---

    #[test]
    fn local_override_and_local_append_combine_over_the_base() {
        // A local file that sets BOTH the field and its `_append`: the override
        // replaces the base's effective array, then the local's own extensions
        // wrap that override (they are no longer silently dropped).
        let base = VibeConfig {
            hooks: Some(HooksConfig {
                post_start: Some(v(&["base"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            hooks: Some(HooksConfig {
                post_start: Some(v(&["local"])),
                post_start_append: Some(v(&["extra"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            merge_configs(&normalize_config(&base), &local)
                .hooks
                .unwrap()
                .post_start,
            Some(v(&["local", "extra"]))
        );
    }

    #[test]
    fn base_own_append_survives_two_file_merge() {
        let base = VibeConfig {
            copy: Some(CopyConfig {
                files: Some(v(&[".env"])),
                files_append: Some(v(&[".base-app"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            copy: Some(CopyConfig {
                files_prepend: Some(v(&["l-pre"])),
                files_append: Some(v(&["l-app"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        let merged = merge_configs(&normalize_config(&base), &local);
        assert_eq!(
            merged.copy.unwrap().files,
            Some(v(&["l-pre", ".env", ".base-app", "l-app"]))
        );
    }

    #[test]
    fn local_override_replaces_base_effective_array() {
        let base = VibeConfig {
            copy: Some(CopyConfig {
                files: Some(v(&[".env"])),
                files_append: Some(v(&[".base-app"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            copy: Some(CopyConfig {
                files: Some(v(&["only"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            merge_configs(&normalize_config(&base), &local)
                .copy
                .unwrap()
                .files,
            Some(v(&["only"]))
        );
    }

    #[test]
    fn copy_files_merging_with_append() {
        let base = VibeConfig {
            copy: Some(CopyConfig {
                files: Some(v(&[".env"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            copy: Some(CopyConfig {
                files_append: Some(v(&[".env.local"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        let merged = merge_configs(&base, &local);
        assert_eq!(merged.copy.unwrap().files, Some(v(&[".env", ".env.local"])));
    }

    #[test]
    fn copy_files_override() {
        let base = VibeConfig {
            copy: Some(CopyConfig {
                files: Some(v(&[".env"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            copy: Some(CopyConfig {
                files: Some(v(&["only.txt"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            merge_configs(&base, &local).copy.unwrap().files,
            Some(v(&["only.txt"]))
        );
    }

    #[test]
    fn untracked_and_modified_parse_and_default_to_absent() {
        let cfg = parse_fields("[copy]\nuntracked = true\nmodified = false\n", "/p");
        let copy = cfg.copy.unwrap();
        assert_eq!(copy.untracked, Some(true));
        assert_eq!(copy.modified, Some(false));

        // Omitting them leaves them unset (the use site reads that as "off").
        let bare = parse_fields("[copy]\nfiles = []\n", "/p");
        let bare_copy = bare.copy.unwrap();
        assert_eq!(bare_copy.untracked, None);
        assert_eq!(bare_copy.modified, None);
    }

    #[test]
    fn local_untracked_overrides_base_and_base_carries_when_local_is_silent() {
        let base = VibeConfig {
            copy: Some(CopyConfig {
                untracked: Some(true),
                modified: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            copy: Some(CopyConfig {
                untracked: Some(false),
                ..Default::default()
            }),
            ..Default::default()
        };
        let merged = merge_configs(&base, &local).copy.unwrap();
        assert_eq!(merged.untracked, Some(false), "local wins when set");
        assert_eq!(merged.modified, Some(true), "base carries when local omits");
    }

    #[test]
    fn a_copy_section_holding_only_toggles_survives_the_merge() {
        // Regression guard: the merge builds `copy` only when SOMETHING merged, so
        // a config whose sole copy content is `untracked` must not be dropped.
        let base = VibeConfig::default();
        let local = VibeConfig {
            copy: Some(CopyConfig {
                untracked: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            merge_configs(&base, &local).copy.unwrap().untracked,
            Some(true)
        );
    }

    #[test]
    fn local_concurrency_takes_precedence() {
        let base = VibeConfig {
            copy: Some(CopyConfig {
                concurrency: Some(4),
                ..Default::default()
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            copy: Some(CopyConfig {
                concurrency: Some(16),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            merge_configs(&base, &local).copy.unwrap().concurrency,
            Some(16)
        );
    }

    #[test]
    fn copy_symlink_merging_with_append() {
        let base = VibeConfig {
            copy: Some(CopyConfig {
                symlink: Some(v(&[".cache"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            copy: Some(CopyConfig {
                symlink_append: Some(v(&[".turbo"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            merge_configs(&base, &local).copy.unwrap().symlink,
            Some(v(&[".cache", ".turbo"]))
        );
    }

    #[test]
    fn copy_symlink_only_still_produces_a_copy_section() {
        // A config whose ONLY copy setting is `symlink` must survive the merge —
        // the section presence check has to account for it.
        let base = VibeConfig {
            copy: Some(CopyConfig {
                symlink: Some(v(&[".cache"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        let merged = merge_configs(&base, &VibeConfig::default());
        assert_eq!(merged.copy.unwrap().symlink, Some(v(&[".cache"])));
    }

    #[test]
    fn copy_symlink_local_override_wins() {
        let base = VibeConfig {
            copy: Some(CopyConfig {
                symlink: Some(v(&[".cache"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            copy: Some(CopyConfig {
                symlink: Some(v(&[".turbo"])),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            merge_configs(&base, &local).copy.unwrap().symlink,
            Some(v(&[".turbo"]))
        );
    }

    #[test]
    fn empty_configs_merge_to_empty() {
        assert_eq!(
            merge_configs(&VibeConfig::default(), &VibeConfig::default()),
            VibeConfig::default()
        );
    }

    #[test]
    fn worktree_local_path_script_wins() {
        let base = VibeConfig {
            worktree: Some(WorktreeConfig {
                path_script: Some("base.sh".into()),
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            worktree: Some(WorktreeConfig {
                path_script: Some("local.sh".into()),
            }),
            ..Default::default()
        };
        assert_eq!(
            merge_configs(&base, &local).worktree.unwrap().path_script,
            Some("local.sh".into())
        );
    }

    #[test]
    fn clean_local_delete_branch_wins() {
        let base = VibeConfig {
            clean: Some(CleanConfig {
                delete_branch: Some(false),
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            clean: Some(CleanConfig {
                delete_branch: Some(true),
            }),
            ..Default::default()
        };
        assert_eq!(
            merge_configs(&base, &local).clean.unwrap().delete_branch,
            Some(true)
        );
    }

    #[test]
    fn clean_base_delete_branch_survives_when_local_has_other_sections() {
        // The regression case: base sets [clean] delete_branch, local only
        // overrides [copy]. delete_branch must survive the merge (it used to be
        // silently dropped because the clean section was never merged).
        let base = VibeConfig {
            clean: Some(CleanConfig {
                delete_branch: Some(true),
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            copy: Some(CopyConfig {
                files: Some(vec!["x".into()]),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            merge_configs(&base, &local).clean.unwrap().delete_branch,
            Some(true)
        );
    }

    #[test]
    fn clean_absent_when_neither_side_has_it() {
        assert!(
            merge_configs(&VibeConfig::default(), &VibeConfig::default())
                .clean
                .is_none()
        );
    }

    #[test]
    fn submodules_local_configs_win() {
        let base = VibeConfig {
            submodules: Some(SubmodulesConfig {
                configs: Some(vec!["libs/base".into()]),
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            submodules: Some(SubmodulesConfig {
                configs: Some(vec!["libs/local".into()]),
            }),
            ..Default::default()
        };
        assert_eq!(
            merge_configs(&base, &local).submodules.unwrap().configs,
            Some(vec!["libs/local".into()])
        );
    }

    #[test]
    fn submodules_base_configs_survive_with_unrelated_local() {
        let base = VibeConfig {
            submodules: Some(SubmodulesConfig {
                configs: Some(vec!["libs/base".into()]),
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            copy: Some(CopyConfig {
                files: Some(vec!["x".into()]),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            merge_configs(&base, &local).submodules.unwrap().configs,
            Some(vec!["libs/base".into()])
        );
    }

    // --- parse_vibe_config ---

    /// Parse and unwrap the [`RawConfig`] for tests that assert on parsed
    /// FIELDS rather than on the raw-ness the newtype protects.
    fn parse_fields(toml_text: &str, path: &str) -> VibeConfig {
        parse_vibe_config(toml_text, path).unwrap().0
    }

    #[test]
    fn parses_empty_config() {
        assert_eq!(parse_fields("", "/p/.vibe.toml"), VibeConfig::default());
    }

    #[test]
    fn parses_full_config() {
        let toml = r#"
[copy]
files = [".env"]
dirs = ["node_modules"]
concurrency = 8

[hooks]
pre_start = ["echo hi"]

[worktree]
path_script = "p.sh"

[clean]
delete_branch = true

[submodules]
configs = ["libs/foo"]
"#;
        let cfg = parse_fields(toml, "/p/.vibe.toml");
        assert_eq!(cfg.copy.as_ref().unwrap().concurrency, Some(8));
        assert_eq!(cfg.clean.as_ref().unwrap().delete_branch, Some(true));
        assert_eq!(
            cfg.submodules.as_ref().unwrap().configs,
            Some(vec!["libs/foo".into()])
        );
        assert_eq!(
            cfg.worktree.as_ref().unwrap().path_script.as_deref(),
            Some("p.sh")
        );
    }

    #[test]
    fn parses_copy_symlink() {
        let cfg = parse_fields(
            "[copy]\ndirs = [\"node_modules\"]\nsymlink = [\".cache\", \".turbo\"]\n",
            "/p/.vibe.toml",
        );
        assert_eq!(
            cfg.copy.unwrap().symlink,
            Some(vec![".cache".into(), ".turbo".into()])
        );
    }

    #[test]
    fn parses_submodules_configs() {
        let cfg = parse_fields("[submodules]\nconfigs = [\"libs/foo\"]\n", "/p/.vibe.toml");
        assert_eq!(
            cfg.submodules.unwrap().configs,
            Some(vec!["libs/foo".into()])
        );
    }

    #[test]
    fn rejects_unknown_top_level_property() {
        let err = parse_vibe_config("unknown_property = true\n", "/path/.vibe.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("/path/.vibe.toml"), "msg: {msg}");
    }

    #[test]
    fn rejects_unknown_nested_property() {
        let toml = "[copy]\nbogus = 1\n";
        let err = parse_vibe_config(toml, "/path/.vibe.toml").unwrap_err();
        assert!(err.to_string().contains("/path/.vibe.toml"));
    }

    #[test]
    fn rejects_unknown_submodules_field() {
        let toml = "[submodules]\nbogus = 1\n";
        let err = parse_vibe_config(toml, "/path/.vibe.toml").unwrap_err();
        assert!(err.to_string().contains("/path/.vibe.toml"));
    }

    #[test]
    fn rejects_concurrency_below_minimum() {
        let err = parse_vibe_config("[copy]\nconcurrency = 0\n", "/path/.vibe.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("copy.concurrency"), "msg: {msg}");
    }

    #[test]
    fn rejects_concurrency_above_maximum() {
        let err = parse_vibe_config("[copy]\nconcurrency = 33\n", "/path/.vibe.toml").unwrap_err();
        assert!(err.to_string().contains("copy.concurrency"));
    }

    #[test]
    fn accepts_concurrency_bounds() {
        assert_eq!(
            parse_fields("[copy]\nconcurrency = 1\n", "/p")
                .copy
                .unwrap()
                .concurrency,
            Some(1)
        );
        assert_eq!(
            parse_fields("[copy]\nconcurrency = 32\n", "/p")
                .copy
                .unwrap()
                .concurrency,
            Some(32)
        );
    }

    // --- extension-field detection (semantics-revision guard input) ---

    fn parse(toml_text: &str) -> RawConfig {
        parse_vibe_config(toml_text, "/p").unwrap()
    }

    #[test]
    fn reports_no_extension_fields_for_plain_config() {
        let cfg = parse("[copy]\nfiles = [\".env\"]\n[hooks]\npost_start = [\"a\"]\n");
        assert!(extension_fields_in_use(&cfg).is_empty());
        assert!(extension_fields_beside_own_field(&cfg).is_empty());
    }

    #[test]
    fn reports_every_extension_field_in_use_by_dotted_name() {
        let cfg = parse(concat!(
            "[copy]\n",
            "files_append = [\"a\"]\n",
            "dirs_prepend = [\"b\"]\n",
            "symlink_append = [\"c\"]\n",
            "[hooks]\n",
            "pre_start_prepend = [\"d\"]\n",
            "post_start_append = [\"e\"]\n",
            "pre_clean_append = [\"f\"]\n",
            "post_clean_prepend = [\"g\"]\n",
        ));
        let mut names = extension_fields_in_use(&cfg);
        names.sort();
        assert_eq!(
            names,
            vec![
                "copy.dirs_prepend",
                "copy.files_append",
                "copy.symlink_append",
                "hooks.post_clean_prepend",
                "hooks.post_start_append",
                "hooks.pre_clean_append",
                "hooks.pre_start_prepend",
            ]
        );
    }

    #[test]
    fn reports_only_extensions_sharing_their_own_base_field() {
        // `files` + `files_append` collide (the TS dropped the append);
        // `dirs_append` alone does not.
        let cfg =
            parse("[copy]\nfiles = [\".env\"]\nfiles_append = [\"x\"]\ndirs_append = [\"y\"]\n");
        assert_eq!(
            extension_fields_beside_own_field(&cfg),
            vec!["copy.files_append"]
        );
    }
}
