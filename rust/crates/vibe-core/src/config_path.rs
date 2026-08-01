//! The vibe config directory (`$HOME/.config/vibe`) and its creation.
//!
//! Ported from `packages/core/src/utils/config-path.ts`. `config_dir` takes the
//! home path explicitly (the binary supplies `Io::home()`) so it stays a pure,
//! testable function. The HOME validation guards against path traversal: HOME
//! must be non-empty, absolute, and free of `..` components.

use crate::error::{Result, VibeError};
use std::path::{Component, Path, PathBuf};

/// Whether an environment-supplied directory root may be joined onto.
///
/// Non-empty, absolute, and free of `..` components. Shared with `vibe doctor`
/// (which layers a Windows prefix restriction on top) so the two commands cannot
/// disagree about which HOME values are usable.
///
/// Why walk `Path::components()` for `..` instead of `value.contains("..")`: a
/// substring check would wrongly reject a legitimate directory like `a..b`,
/// while a component walk rejects only a real parent-dir segment.
pub(crate) fn is_valid_abs_root(value: &str) -> bool {
    let path = Path::new(value);

    let is_non_empty = !value.is_empty();
    let is_absolute = path.is_absolute();
    let has_parent_dir = path.components().any(|c| matches!(c, Component::ParentDir));

    is_non_empty && is_absolute && !has_parent_dir
}

/// `$HOME/.config/vibe`, after validating `home`.
pub fn config_dir(home: &str) -> Result<PathBuf> {
    let home_path = Path::new(home);

    if !is_valid_abs_root(home) {
        return Err(VibeError::Configuration(
            "Invalid HOME environment variable. \
             HOME must be an absolute path without '..' components."
                .to_string(),
        ));
    }

    Ok(home_path.join(".config").join("vibe"))
}

/// Create the config dir (and parents). On unix the directory is mode 0700.
///
/// An already-existing directory is not an error, matching the TS
/// `isAlreadyExists` swallow.
pub fn ensure_config_dir(home: &str) -> Result<PathBuf> {
    let dir = config_dir(home)?;

    if dir.is_dir() {
        return Ok(dir); // Already exists: nothing to do.
    }

    std::fs::create_dir_all(&dir).map_err(|e| {
        VibeError::FileSystem(format!(
            "Failed to create config dir {}: {e}",
            dir.display()
        ))
    })?;

    set_dir_permissions_0700(&dir)?;
    Ok(dir)
}

/// Set directory mode to 0700 (owner-only) on unix; no-op elsewhere.
#[cfg(unix)]
fn set_dir_permissions_0700(dir: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o700);
    std::fs::set_permissions(dir, perms)
        .map_err(|e| VibeError::FileSystem(format!("Failed to chmod 0700 {}: {e}", dir.display())))
}

// Why not error on non-unix: Windows ACLs are out of scope for now; the trust
// store still works, just without the unix mode hardening.
#[cfg(not(unix))]
fn set_dir_permissions_0700(_dir: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_expected_path() {
        let dir = config_dir("/home/user").unwrap();
        assert_eq!(dir, PathBuf::from("/home/user/.config/vibe"));
    }

    #[test]
    fn rejects_empty_home() {
        assert!(config_dir("").is_err());
    }

    #[test]
    fn rejects_relative_home() {
        assert!(config_dir("relative/path").is_err());
    }

    #[test]
    fn rejects_parent_dir_component() {
        assert!(config_dir("/home/../etc").is_err());
    }

    #[test]
    fn allows_dotdot_substring_in_a_name() {
        // `a..b` is a single, legitimate path segment, not a parent-dir ref.
        let dir = config_dir("/home/a..b").unwrap();
        assert_eq!(dir, PathBuf::from("/home/a..b/.config/vibe"));
    }

    #[cfg(unix)]
    #[test]
    fn ensure_creates_dir_mode_0700() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_str().unwrap();
        let dir = ensure_config_dir(home).unwrap();
        assert!(dir.is_dir());
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        // Idempotent: a second call on an existing dir succeeds.
        assert!(ensure_config_dir(home).is_ok());
    }
}
