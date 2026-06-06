//! Fallback platform module for targets other than macOS / Linux (e.g. Windows).
//!
//! Native CoW cloning is unavailable here, so `clone_file` / `clone_directory`
//! return [`CloneError::Unsupported`] (a soft error the caller falls back from)
//! and `is_available()` is `false`. `move_to_trash` is still provided by the
//! cross-platform `trash` crate at the lib.rs level, so trashing works on
//! Windows even though cloning does not.

use crate::error::{CloneError, CloneResult};
use std::path::Path;

/// Clone a file — unsupported on this platform; always returns
/// [`CloneError::Unsupported`] so the caller falls back to a non-native copy.
pub fn clone_file(_src: &Path, _dest: &Path) -> CloneResult<()> {
    Err(CloneError::Unsupported(
        "native clone is not supported on this platform",
    ))
}

/// Clone a directory — unsupported on this platform; always returns
/// [`CloneError::Unsupported`] so the caller falls back to a non-native copy.
pub fn clone_directory(_src: &Path, _dest: &Path) -> CloneResult<()> {
    Err(CloneError::Unsupported(
        "native clone is not supported on this platform",
    ))
}

/// Whether native cloning is available — always `false` on this platform.
pub fn is_available() -> bool {
    false
}

/// Whether directory cloning is supported — always `false` on this platform.
pub fn supports_directory() -> bool {
    false
}

/// Platform name — `"unsupported"` since native clone is not available here.
pub fn get_platform() -> &'static str {
    "unsupported"
}
