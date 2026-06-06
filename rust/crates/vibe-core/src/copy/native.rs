//! The `NativeClone` seam over the `vibe-native` crate.
//!
//! Ported from `utils/copy/native/types.ts` (the `NativeClone` interface). The
//! production [`RealNativeClone`] delegates to `vibe-native`'s plain `pub fn`s;
//! [`FakeNative`] lets tests toggle availability / directory support and force a
//! symlink rejection (finding #5) without touching the filesystem.

use super::types::{CopyError, CopyResult};
use std::path::Path;

/// Abstraction over native Copy-on-Write cloning (clonefile / FICLONE) + trash.
pub trait NativeClone {
    /// Clone a single file. `UnsupportedFileType` on a symlink/device/etc.
    fn clone_file(&self, src: &Path, dest: &Path) -> CopyResult<()>;
    /// Clone a directory (macOS only; Linux returns a non-fatal error).
    fn clone_directory(&self, src: &Path, dest: &Path) -> CopyResult<()>;
    /// Whether native clone is available on this platform.
    fn is_available(&self) -> bool;
    /// Whether directory cloning is supported (macOS clonefile: true).
    fn supports_directory(&self) -> bool;
    /// Platform name (`"darwin"`/`"linux"`/`"unsupported"`).
    fn get_platform(&self) -> &'static str;
    /// Move a path to the system trash.
    fn move_to_trash(&self, path: &Path) -> Result<(), String>;
    /// Release any native resources (no-op for the Rust binding; kept for parity).
    fn close(&self) {}
}

/// Forward through a reference so `&dyn NativeClone` satisfies `impl NativeClone`
/// (lets commands pass their `&dyn NativeClone` seam into generic helpers).
impl<T: NativeClone + ?Sized> NativeClone for &T {
    fn clone_file(&self, src: &Path, dest: &Path) -> CopyResult<()> {
        (**self).clone_file(src, dest)
    }
    fn clone_directory(&self, src: &Path, dest: &Path) -> CopyResult<()> {
        (**self).clone_directory(src, dest)
    }
    fn is_available(&self) -> bool {
        (**self).is_available()
    }
    fn supports_directory(&self) -> bool {
        (**self).supports_directory()
    }
    fn get_platform(&self) -> &'static str {
        (**self).get_platform()
    }
    fn move_to_trash(&self, path: &Path) -> Result<(), String> {
        (**self).move_to_trash(path)
    }
}

/// Production [`NativeClone`] delegating to the `vibe-native` crate.
pub struct RealNativeClone;

impl NativeClone for RealNativeClone {
    fn clone_file(&self, src: &Path, dest: &Path) -> CopyResult<()> {
        vibe_native::clone_file(src, dest).map_err(map_clone_error)
    }

    fn clone_directory(&self, src: &Path, dest: &Path) -> CopyResult<()> {
        vibe_native::clone_directory(src, dest).map_err(map_clone_error)
    }

    fn is_available(&self) -> bool {
        vibe_native::is_available()
    }

    fn supports_directory(&self) -> bool {
        vibe_native::supports_directory()
    }

    fn get_platform(&self) -> &'static str {
        vibe_native::get_platform()
    }

    fn move_to_trash(&self, path: &Path) -> Result<(), String> {
        vibe_native::move_to_trash(path).map_err(|e| e.to_string())
    }
}

/// Map a `vibe-native` clone error into a [`CopyError`], crucially preserving the
/// `UnsupportedFileType` distinction so the executor does NOT fall back (finding
/// #5). `Unsupported` (e.g. Linux directory clone) maps to a plain `Failed` so
/// the executor MAY fall back.
fn map_clone_error(e: vibe_native::CloneError) -> CopyError {
    match e {
        vibe_native::CloneError::UnsupportedFileType { file_type } => {
            CopyError::UnsupportedFileType(format!(
                "Unsupported file type: {file_type} (only regular files and directories are allowed)"
            ))
        }
        other => CopyError::Failed(other.to_string()),
    }
}

#[cfg(any(test, feature = "test-util"))]
pub use fake::FakeNative;

#[cfg(any(test, feature = "test-util"))]
mod fake {
    use super::*;
    use std::cell::RefCell;

    /// A configurable [`NativeClone`] for tests: toggles availability and
    /// directory support, records clone calls, and can force a symlink rejection
    /// (the `UnsupportedFileType` path that must NOT fall back).
    pub struct FakeNative {
        available: bool,
        supports_dir: bool,
        platform: &'static str,
        /// When set, every `clone_file`/`clone_directory` returns this error.
        forced_error: Option<CopyError>,
        pub clone_file_calls: RefCell<Vec<(String, String)>>,
        pub clone_dir_calls: RefCell<Vec<(String, String)>>,
        pub trash_calls: RefCell<Vec<String>>,
    }

    impl FakeNative {
        /// Available, with directory cloning (macOS-like).
        pub fn macos() -> Self {
            FakeNative {
                available: true,
                supports_dir: true,
                platform: "darwin",
                forced_error: None,
                clone_file_calls: RefCell::new(vec![]),
                clone_dir_calls: RefCell::new(vec![]),
                trash_calls: RefCell::new(vec![]),
            }
        }

        /// Available, files only (Linux-like).
        pub fn linux() -> Self {
            FakeNative {
                available: true,
                supports_dir: false,
                platform: "linux",
                forced_error: None,
                clone_file_calls: RefCell::new(vec![]),
                clone_dir_calls: RefCell::new(vec![]),
                trash_calls: RefCell::new(vec![]),
            }
        }

        /// Windows-like: native clone unavailable, platform reports "windows".
        /// (Used to drive `select_directory_strategy`'s Windows/robocopy branch
        /// host-independently — Windows is not in CI.)
        pub fn windows() -> Self {
            FakeNative {
                available: false,
                supports_dir: false,
                platform: "windows",
                forced_error: None,
                clone_file_calls: RefCell::new(vec![]),
                clone_dir_calls: RefCell::new(vec![]),
                trash_calls: RefCell::new(vec![]),
            }
        }

        /// Unavailable native clone.
        pub fn unavailable() -> Self {
            FakeNative {
                available: false,
                supports_dir: false,
                platform: "unsupported",
                forced_error: None,
                clone_file_calls: RefCell::new(vec![]),
                clone_dir_calls: RefCell::new(vec![]),
                trash_calls: RefCell::new(vec![]),
            }
        }

        /// Force the clone to reject with `UnsupportedFileType` (finding #5 test).
        pub fn rejecting_symlink(mut self) -> Self {
            self.forced_error = Some(CopyError::UnsupportedFileType(
                "Unsupported file type: symlink (only regular files and directories are allowed)"
                    .to_string(),
            ));
            self
        }

        /// Force the clone to fail with a soft (fallback-eligible) error.
        pub fn failing_soft(mut self) -> Self {
            self.forced_error = Some(CopyError::Failed("simulated ENOTSUP".to_string()));
            self
        }
    }

    impl NativeClone for FakeNative {
        fn clone_file(&self, src: &Path, dest: &Path) -> CopyResult<()> {
            self.clone_file_calls.borrow_mut().push((
                src.to_string_lossy().into_owned(),
                dest.to_string_lossy().into_owned(),
            ));
            if let Some(e) = &self.forced_error {
                return Err(e.clone());
            }
            Ok(())
        }

        fn clone_directory(&self, src: &Path, dest: &Path) -> CopyResult<()> {
            self.clone_dir_calls.borrow_mut().push((
                src.to_string_lossy().into_owned(),
                dest.to_string_lossy().into_owned(),
            ));
            if let Some(e) = &self.forced_error {
                return Err(e.clone());
            }
            Ok(())
        }

        fn is_available(&self) -> bool {
            self.available
        }

        fn supports_directory(&self) -> bool {
            self.supports_dir
        }

        fn get_platform(&self) -> &'static str {
            self.platform
        }

        fn move_to_trash(&self, path: &Path) -> Result<(), String> {
            self.trash_calls
                .borrow_mut()
                .push(path.to_string_lossy().into_owned());
            Ok(())
        }
    }
}
