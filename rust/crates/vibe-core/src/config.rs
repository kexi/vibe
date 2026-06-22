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
    /// Parallel directory-copy operations (1-32, default 4 applied at use site).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<i64>,
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

    Ok(config)
}

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
    let concurrency = local
        .copy
        .as_ref()
        .and_then(|c| c.concurrency)
        .or_else(|| base.copy.as_ref().and_then(|c| c.concurrency));

    if merged_files.is_some() || merged_dirs.is_some() || concurrency.is_some() {
        merged.copy = Some(CopyConfig {
            files: merged_files,
            dirs: merged_dirs,
            concurrency,
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
"#;
        let cfg = parse_vibe_config(toml, "/p/.vibe.toml").unwrap();
        assert_eq!(cfg.copy.as_ref().unwrap().concurrency, Some(8));
        assert_eq!(cfg.clean.as_ref().unwrap().delete_branch, Some(true));
        assert_eq!(
            cfg.worktree.as_ref().unwrap().path_script.as_deref(),
            Some("p.sh")
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
