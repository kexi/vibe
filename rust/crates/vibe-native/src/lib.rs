//! Native Copy-on-Write clone + trash operations for the vibe CLI.
//!
//! Ported from `packages/native/src` with ALL N-API scaffolding removed
//! (`napi`/`napi-derive`/`napi-build`/`tokio` and the `*_async` fns). Only
//! synchronous `pub fn`s remain; `vibe-core` links this as an ordinary Rust
//! dependency and offloads concurrency itself (`std::thread`).
//!
//! The platform module is cfg-gated INSIDE this crate, so `vibe-core` can depend
//! on `vibe-native` unconditionally (no cfg in the consumer): on macOS it uses
//! `clonefile`, on Linux `FICLONE`, elsewhere a stub that reports unavailable.
//!
//! # Security Considerations (preserved EXACTLY from the original)
//!
//! - **File type validation** (`validate_file_type`): only regular files and
//!   directories are clonable. Symlinks, device files, sockets and FIFOs are
//!   rejected via `symlink_metadata` ([`CloneError::UnsupportedFileType`]),
//!   preventing symlink-following (CWE-59), device-file access and socket/FIFO
//!   exploitation (OWASP A01:2021).
//! - **macOS** uses `clonefile(CLONE_NOFOLLOW)` and captures errno immediately
//!   via `__error()` (TOCTOU race fix, OWASP A04:2021).
//! - **Linux** opens the source `O_NOFOLLOW`, `fstat`s the open fd (not the
//!   path) and preserves permissions before the `FICLONE` ioctl.
//!
//! Callers remain responsible for path-traversal/containment checks (this crate
//! does NOT canonicalize) — see `vibe-core`'s `glob` containment guard.

pub mod error;

pub use error::{CloneError, CloneResult};

#[cfg(target_os = "macos")]
mod darwin;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod unsupported;

use std::path::Path;

#[cfg(target_os = "macos")]
use darwin as platform;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
use unsupported as platform;

/// Clone a single file using native Copy-on-Write.
///
/// - macOS: `clonefile()` (APFS)
/// - Linux: `FICLONE` ioctl (Btrfs/XFS)
/// - other: [`CloneError::Unsupported`]
pub fn clone_file(src: &Path, dest: &Path) -> CloneResult<()> {
    platform::clone_file(src, dest)
}

/// Clone a directory using native Copy-on-Write.
///
/// - macOS: `clonefile()` (supports directories)
/// - Linux: unsupported (FICLONE is files only) → [`CloneError::Unsupported`]
/// - other: [`CloneError::Unsupported`]
pub fn clone_directory(src: &Path, dest: &Path) -> CloneResult<()> {
    platform::clone_directory(src, dest)
}

/// Whether native clone operations are available on this platform.
pub fn is_available() -> bool {
    platform::is_available()
}

/// Whether directory cloning is supported (macOS clonefile: true; Linux: false).
pub fn supports_directory() -> bool {
    platform::supports_directory()
}

/// The current platform name: `"darwin"`, `"linux"`, or `"unsupported"`.
pub fn get_platform() -> &'static str {
    platform::get_platform()
}

/// Move a file or directory to the system trash (cross-platform via `trash`).
///
/// - macOS: Finder Trash
/// - Linux: XDG Trash (`~/.local/share/Trash`)
/// - Windows: Recycle Bin
pub fn move_to_trash(path: &Path) -> Result<(), trash::Error> {
    trash::delete(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_platform_is_known() {
        let p = get_platform();
        assert!(
            p == "darwin" || p == "linux" || p == "unsupported",
            "unexpected platform: {p}"
        );
    }

    #[test]
    fn directory_support_matches_platform() {
        // macOS clonefile supports dirs; everything else does not.
        if get_platform() == "darwin" {
            assert!(supports_directory());
        } else {
            assert!(!supports_directory());
        }
    }

    #[test]
    fn move_to_trash_round_trips_a_temp_file() {
        // Trashing works on every supported dev platform (macOS/Linux). The file
        // must be gone from its original location afterward.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("trash-me.txt");
        std::fs::write(&file, b"bye").unwrap();
        // CI sandboxes may lack a trash backend; tolerate an Err without failing
        // the suite (the security/argv behavior is asserted elsewhere; this only
        // smoke-tests the binding).
        if move_to_trash(&file).is_ok() {
            assert!(!file.exists(), "file should be gone after trashing");
        }
    }
}
