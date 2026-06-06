//! Atomic, 0600 file writes for the config store (`settings.json`, `mru.json`).
//!
//! The TS used temp-file + `rename` for crash safety. This port additionally
//! hardens the temp file: on unix it is created with `O_EXCL` + mode 0600 so it
//! is owner-only from the first byte and cannot be hijacked via a pre-planted
//! symlink or a colliding temp name. Both `settings_io` and `mru` route through
//! here so the security properties are written once.

use crate::error::{Result, VibeError};
use std::path::{Path, PathBuf};

/// Atomically write `bytes` to `path` with mode 0600 (unix).
///
/// Strategy: create a sibling temp file with `create_new` (`O_EXCL`) + 0600,
/// write + fsync, then `rename` over the destination (atomic on the same fs).
/// On any failure the temp file is removed. On non-unix this falls back to a
/// plain `create_new` write — Windows ACL hardening is out of scope for now.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| VibeError::FileSystem(format!("path has no parent: {}", path.display())))?;

    if !parent.is_dir() {
        std::fs::create_dir_all(parent).map_err(fs_err("create parent"))?;
    }

    let temp = unique_temp_path(path);
    let result = write_temp_then_rename(&temp, path, bytes);
    if result.is_err() {
        let _ = std::fs::remove_file(&temp); // Best-effort cleanup.
    }
    result
}

fn write_temp_then_rename(temp: &Path, dest: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;

    let mut file = open_temp_0600(temp)?;
    file.write_all(bytes).map_err(fs_err("write temp"))?;
    file.sync_all().map_err(fs_err("sync temp"))?;
    drop(file);

    std::fs::rename(temp, dest).map_err(fs_err("rename temp"))
}

#[cfg(unix)]
fn open_temp_0600(temp: &Path) -> Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true) // O_EXCL: fail if it exists (symlink/collision guard).
        .mode(0o600)
        .open(temp)
        .map_err(fs_err("create temp 0600"))
}

#[cfg(not(unix))]
fn open_temp_0600(temp: &Path) -> Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp)
        .map_err(fs_err("create temp"))
}

/// A temp path next to `path`. `create_new` makes collisions an error rather
/// than a clobber, so this only needs to avoid the common case, not be unique.
fn unique_temp_path(path: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(format!(".tmp.{pid}.{nanos}"));
    PathBuf::from(tmp)
}

fn fs_err(what: &'static str) -> impl Fn(std::io::Error) -> VibeError {
    move |e| VibeError::FileSystem(format!("Failed to {what}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibe_test_support::Fixture;

    #[test]
    fn writes_content_and_renames() {
        let fx = Fixture::new();
        let dest = fx.join("out.json");
        atomic_write(&dest, b"hello").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "hello");
    }

    #[cfg(unix)]
    #[test]
    fn written_file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let fx = Fixture::new();
        let dest = fx.join("secret.json");
        atomic_write(&dest, b"x").unwrap();
        let mode = std::fs::metadata(&dest).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn overwrites_existing_file_atomically() {
        let fx = Fixture::new();
        let dest = fx.write("out.json", "old");
        atomic_write(&dest, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new");
    }
}
