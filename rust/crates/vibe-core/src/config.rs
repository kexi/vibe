//! `.vibe.toml` / `.vibe.local.toml` config types, parsing and merging.
//!
//! Ported from `packages/core/src/types/config.ts` (the Zod schema) and the
//! merge logic in `packages/core/src/utils/config.ts`. serde's
//! `deny_unknown_fields` reproduces Zod's `.strict()`, and concurrency range
//! validation (1-32) is applied after deserialization. The trust-gated *loader*
//! lives with the settings/trust code; this module is pure (types + merge) so it
//! is unit-testable without filesystem or trust state.

use crate::error::{Result, VibeError};
use serde::{Deserialize, Serialize};

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<SummaryConfig>,
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

/// `[summary]`: the external command that produces the SUMMARY column of
/// `vibe list`.
///
/// Both fields are scalars and both are optional, so the section merges by
/// simple override (`.vibe.local.toml` wins per FIELD, not per section) — the
/// same shape `[worktree] path_script` already uses. There is deliberately no
/// array form: the command is one shell line, and a `_prepend`/`_append` pair
/// on a shell string would concatenate text, not compose behaviour.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SummaryConfig {
    /// Shell command run once per `vibe list`, receiving the batch of
    /// cache-missing worktrees as JSON on stdin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// How long the command may run before it is killed, in seconds
    /// (1-3600, validated in [`parse_vibe_config`]). The default of
    /// [`DEFAULT_SUMMARY_TIMEOUT_SECONDS`] is applied at the use site rather
    /// than here, so an absent value stays distinguishable from an explicit one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
}

/// Parse a `VibeConfig` from TOML text, validating it like the Zod schema.
///
/// `file_path` is woven into the error message exactly as the TS
/// `parseVibeConfig` does (`Invalid configuration in <path>: ...`).
pub fn parse_vibe_config(toml_text: &str, file_path: &str) -> Result<VibeConfig> {
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

    // `[summary] timeout_seconds` range check. Zero is rejected because a
    // zero-second deadline can only ever kill the command before it produces
    // anything, and the upper bound keeps a typo (`timeout_seconds = 36000`)
    // from turning `vibe list` into a ten-hour hang.
    if let Some(t) = config.summary.as_ref().and_then(|s| s.timeout_seconds) {
        if !(1..=MAX_SUMMARY_TIMEOUT_SECONDS).contains(&t) {
            return Err(VibeError::Configuration(format!(
                "Invalid configuration in {file_path}:\n  - summary.timeout_seconds: must be between 1 and {MAX_SUMMARY_TIMEOUT_SECONDS}"
            )));
        }
    }

    Ok(config)
}

/// Longest `[summary] timeout_seconds` accepted (one hour).
pub const MAX_SUMMARY_TIMEOUT_SECONDS: u64 = 3600;

/// Deadline applied when `[summary]` sets no `timeout_seconds`.
pub const DEFAULT_SUMMARY_TIMEOUT_SECONDS: u64 = 30;

/// Merge a base array with override/prepend/append, matching `mergeArrayField`.
///
/// Precedence: an explicit `override` wins outright. Otherwise prepend/append
/// wrap the base; with no base, prepend+append concatenate (only if either is
/// present), else `None`.
pub fn merge_array_field(
    base: Option<&[String]>,
    override_: Option<&[String]>,
    prepend: Option<&[String]>,
    append: Option<&[String]>,
) -> Option<Vec<String>> {
    if let Some(over) = override_ {
        return Some(over.to_vec());
    }

    let Some(base) = base else {
        if prepend.is_some() || append.is_some() {
            let mut out = Vec::new();
            out.extend(prepend.unwrap_or_default().iter().cloned());
            out.extend(append.unwrap_or_default().iter().cloned());
            return Some(out);
        }
        return None;
    };

    let mut out = Vec::new();
    out.extend(prepend.unwrap_or_default().iter().cloned());
    out.extend(base.iter().cloned());
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

    // summary: present if either side has it; each scalar merged independently
    // so a local file overriding only `timeout_seconds` keeps the shared
    // `command` (overriding the section wholesale would silently disable the
    // SUMMARY column instead).
    if base.summary.is_some() || local.summary.is_some() {
        let command = local
            .summary
            .as_ref()
            .and_then(|s| s.command.clone())
            .or_else(|| base.summary.as_ref().and_then(|s| s.command.clone()));
        let timeout_seconds = local
            .summary
            .as_ref()
            .and_then(|s| s.timeout_seconds)
            .or_else(|| base.summary.as_ref().and_then(|s| s.timeout_seconds));
        merged.summary = Some(SummaryConfig {
            command,
            timeout_seconds,
        });
    }

    merged
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
    fn override_takes_precedence() {
        let r = merge_array_field(Some(&v(&["a"])), Some(&v(&["b"])), Some(&v(&["p"])), None);
        assert_eq!(r, Some(v(&["b"])));
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

    // --- merge_configs ---

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
        let cfg = parse_vibe_config("[copy]\nuntracked = true\nmodified = false\n", "/p").unwrap();
        let copy = cfg.copy.unwrap();
        assert_eq!(copy.untracked, Some(true));
        assert_eq!(copy.modified, Some(false));

        // Omitting them leaves them unset (the use site reads that as "off").
        let bare = parse_vibe_config("[copy]\nfiles = []\n", "/p").unwrap();
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

    #[test]
    fn parses_empty_config() {
        assert_eq!(
            parse_vibe_config("", "/p/.vibe.toml").unwrap(),
            VibeConfig::default()
        );
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
        let cfg = parse_vibe_config(toml, "/p/.vibe.toml").unwrap();
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
        let cfg = parse_vibe_config(
            "[copy]\ndirs = [\"node_modules\"]\nsymlink = [\".cache\", \".turbo\"]\n",
            "/p/.vibe.toml",
        )
        .unwrap();
        assert_eq!(
            cfg.copy.unwrap().symlink,
            Some(vec![".cache".into(), ".turbo".into()])
        );
    }

    #[test]
    fn parses_submodules_configs() {
        let cfg =
            parse_vibe_config("[submodules]\nconfigs = [\"libs/foo\"]\n", "/p/.vibe.toml").unwrap();
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

    // --- [summary] ---

    #[test]
    fn parses_summary_section() {
        let cfg = parse_vibe_config(
            "[summary]\ncommand = \"./s.sh\"\ntimeout_seconds = 12\n",
            "/p/.vibe.toml",
        )
        .unwrap();
        let summary = cfg.summary.unwrap();
        assert_eq!(summary.command.as_deref(), Some("./s.sh"));
        assert_eq!(summary.timeout_seconds, Some(12));
    }

    #[test]
    fn summary_timeout_is_optional_so_the_use_site_can_default_it() {
        let cfg = parse_vibe_config("[summary]\ncommand = \"./s.sh\"\n", "/p").unwrap();
        assert_eq!(cfg.summary.unwrap().timeout_seconds, None);
    }

    #[test]
    fn rejects_unknown_summary_field() {
        let err = parse_vibe_config("[summary]\nbogus = 1\n", "/path/.vibe.toml").unwrap_err();
        assert!(err.to_string().contains("/path/.vibe.toml"));
    }

    #[test]
    fn rejects_summary_timeout_outside_the_allowed_range() {
        // Zero can only kill the command before it answers; the upper bound
        // stops a typo from turning `vibe list` into an hours-long hang.
        for bad in ["0", "3601"] {
            let err = parse_vibe_config(&format!("[summary]\ntimeout_seconds = {bad}\n"), "/p")
                .unwrap_err();
            let msg = err.to_string();
            assert!(msg.contains("summary.timeout_seconds"), "msg: {msg}");
        }
    }

    #[test]
    fn accepts_summary_timeout_bounds() {
        for good in [1, MAX_SUMMARY_TIMEOUT_SECONDS] {
            let cfg =
                parse_vibe_config(&format!("[summary]\ntimeout_seconds = {good}\n"), "/p").unwrap();
            assert_eq!(cfg.summary.unwrap().timeout_seconds, Some(good));
        }
    }

    #[test]
    fn summary_scalars_merge_independently() {
        // A local file overriding only the timeout must keep the shared command:
        // a whole-section override would silently disable the SUMMARY column.
        let base = VibeConfig {
            summary: Some(SummaryConfig {
                command: Some("base.sh".into()),
                timeout_seconds: Some(10),
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            summary: Some(SummaryConfig {
                command: None,
                timeout_seconds: Some(60),
            }),
            ..Default::default()
        };
        let merged = merge_configs(&base, &local).summary.unwrap();
        assert_eq!(merged.command.as_deref(), Some("base.sh"));
        assert_eq!(merged.timeout_seconds, Some(60));
    }

    #[test]
    fn summary_local_command_wins_and_base_survives_an_unrelated_local() {
        let base = VibeConfig {
            summary: Some(SummaryConfig {
                command: Some("base.sh".into()),
                timeout_seconds: None,
            }),
            ..Default::default()
        };
        let local = VibeConfig {
            summary: Some(SummaryConfig {
                command: Some("local.sh".into()),
                timeout_seconds: None,
            }),
            ..Default::default()
        };
        assert_eq!(
            merge_configs(&base, &local).summary.unwrap().command,
            Some("local.sh".into())
        );

        let unrelated = VibeConfig {
            copy: Some(CopyConfig {
                files: Some(vec!["x".into()]),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            merge_configs(&base, &unrelated).summary.unwrap().command,
            Some("base.sh".into())
        );
    }

    #[test]
    fn summary_absent_when_neither_side_has_it() {
        assert!(
            merge_configs(&VibeConfig::default(), &VibeConfig::default())
                .summary
                .is_none()
        );
    }

    #[test]
    fn accepts_concurrency_bounds() {
        assert_eq!(
            parse_vibe_config("[copy]\nconcurrency = 1\n", "/p")
                .unwrap()
                .copy
                .unwrap()
                .concurrency,
            Some(1)
        );
        assert_eq!(
            parse_vibe_config("[copy]\nconcurrency = 32\n", "/p")
                .unwrap()
                .copy
                .unwrap()
                .concurrency,
            Some(32)
        );
    }
}
