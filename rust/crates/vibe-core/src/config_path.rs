//! The vibe config directory (`$HOME/.config/vibe`), the cache directory
//! (`$XDG_CACHE_HOME/vibe` or `$HOME/.cache/vibe`), and their creation.
//!
//! Ported from `packages/core/src/utils/config-path.ts`. `config_dir` takes the
//! home path explicitly (the binary supplies `Io::home()`) so it stays a pure,
//! testable function. The HOME validation guards against path traversal: HOME
//! must be non-empty, absolute, and free of `..` components.

use crate::error::{Result, VibeError};
use crate::io::Io;
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

/// The vibe cache root: `$XDG_CACHE_HOME/vibe` when that variable names a
/// usable absolute directory, otherwise `$HOME/.cache/vibe`.
///
/// Why honour `XDG_CACHE_HOME` here but not for the config dir: the config dir
/// is a documented, stable location users edit and back up (and moving it would
/// orphan every existing trust record), whereas this holds regenerable derived
/// data — exactly what the XDG cache directory is for, and what a user pointing
/// `XDG_CACHE_HOME` at a tmpfs expects to be redirected.
///
/// An `XDG_CACHE_HOME` that is empty, relative, or contains `..` is IGNORED
/// rather than rejected: the cache is best-effort, and refusing to list
/// worktrees because an unrelated environment variable is malformed would turn a
/// cosmetic column into a hard failure.
pub fn cache_dir(io: &impl Io) -> Result<PathBuf> {
    let xdg = io.env("XDG_CACHE_HOME").filter(|v| is_valid_abs_root(v));
    if let Some(xdg) = xdg {
        return Ok(Path::new(&xdg).join("vibe"));
    }

    let home = io.home().unwrap_or_default();
    if !is_valid_abs_root(&home) {
        return Err(VibeError::Configuration(
            "Invalid HOME environment variable. \
             HOME must be an absolute path without '..' components."
                .to_string(),
        ));
    }
    Ok(Path::new(&home).join(".cache").join("vibe"))
}

/// Create `<cache_dir>/<subdir>` (and parents), mode 0700 on unix.
///
/// Same 0700 hardening as the config dir: the summaries written under it are
/// derived from repository contents and from the output of a user-configured
/// command, neither of which should become world-readable just because it is
/// "only" a cache.
pub fn ensure_cache_subdir(io: &impl Io, subdir: &str) -> Result<PathBuf> {
    let dir = cache_dir(io)?.join(subdir);

    if dir.is_dir() {
        return Ok(dir);
    }

    std::fs::create_dir_all(&dir).map_err(|e| {
        VibeError::FileSystem(format!("Failed to create cache dir {}: {e}", dir.display()))
    })?;

    set_dir_permissions_0700(&dir)?;
    Ok(dir)
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
    use vibe_test_support::{fake_root, fake_root_str};

    #[test]
    fn builds_expected_path() {
        // A per-host root: `/home/user` carries no drive prefix, so on Windows it
        // is relative and `config_dir` would (correctly) reject it.
        let dir = config_dir(&fake_root_str("home/user")).unwrap();
        assert_eq!(dir, fake_root("home/user").join(".config").join("vibe"));
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
        // Absolute on both hosts, so it is the ParentDir component — not the
        // absoluteness check — that does the rejecting. A bare `/home/../etc` is
        // relative on Windows and would never reach the guard under test.
        assert!(config_dir(&fake_root_str("home/../etc")).is_err());
    }

    #[test]
    fn allows_dotdot_substring_in_a_name() {
        // `a..b` is a single, legitimate path segment, not a parent-dir ref.
        let dir = config_dir(&fake_root_str("home/a..b")).unwrap();
        assert_eq!(dir, fake_root("home/a..b").join(".config").join("vibe"));
    }

    // --- cache_dir ---

    #[test]
    fn cache_dir_defaults_to_home_dot_cache() {
        let io = crate::io::FakeIo::new().with_env("HOME", &fake_root_str("home/user"));
        assert_eq!(
            cache_dir(&io).unwrap(),
            fake_root("home/user").join(".cache").join("vibe")
        );
    }

    #[test]
    fn cache_dir_honours_a_valid_xdg_cache_home() {
        let io = crate::io::FakeIo::new()
            .with_env("HOME", &fake_root_str("home/user"))
            .with_env("XDG_CACHE_HOME", &fake_root_str("var/cache"));
        assert_eq!(cache_dir(&io).unwrap(), fake_root("var/cache").join("vibe"));
    }

    #[test]
    fn cache_dir_ignores_a_malformed_xdg_cache_home() {
        // What it guarantees: a bogus XDG_CACHE_HOME degrades to the HOME path
        // instead of failing the command that wanted the cache.
        for bad in ["", "relative/cache", "/tmp/../etc"] {
            let io = crate::io::FakeIo::new()
                .with_env("HOME", &fake_root_str("home/user"))
                .with_env("XDG_CACHE_HOME", bad);
            assert_eq!(
                cache_dir(&io).unwrap(),
                fake_root("home/user").join(".cache").join("vibe"),
                "not ignored: {bad:?}"
            );
        }
    }

    #[test]
    fn cache_dir_rejects_an_invalid_home_when_xdg_is_unset() {
        let io = crate::io::FakeIo::new().with_env("HOME", "relative/home");
        assert!(cache_dir(&io).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn ensure_cache_subdir_creates_dir_mode_0700() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let io = crate::io::FakeIo::new().with_env("HOME", tmp.path().to_str().unwrap());
        let dir = ensure_cache_subdir(&io, "summaries").unwrap();
        assert!(dir.is_dir());
        assert!(dir.ends_with("vibe/summaries"));
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        // Idempotent.
        assert!(ensure_cache_subdir(&io, "summaries").is_ok());
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
