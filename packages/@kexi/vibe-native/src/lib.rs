//! Native clone operations for Node.js
//!
//! Provides Copy-on-Write cloning using:
//! - macOS: clonefile() on APFS
//! - Linux: FICLONE ioctl on Btrfs/XFS
//!
//! # Security Considerations
//!
//! This crate implements several security measures to protect against common
//! file operation vulnerabilities:
//!
//! ## File Type Validation (OWASP A01:2021 - Broken Access Control)
//!
//! Only regular files and directories are allowed for cloning. The following
//! file types are explicitly rejected:
//!
//! - **Symlinks**: Prevents symlink following attacks (CWE-59, CWE-61) where
//!   an attacker could trick the application into reading or writing files
//!   outside the intended directory.
//!
//! - **Device files**: Block and character device files are rejected to prevent
//!   access to system devices (e.g., /dev/mem, /dev/sda) which could lead to
//!   information disclosure or system compromise.
//!
//! - **Sockets and FIFOs**: Named pipes and Unix domain sockets are rejected
//!   to prevent inter-process communication exploitation.
//!
//! ## Path Traversal Protection
//!
//! **Important**: This crate does NOT perform path traversal validation.
//! The caller is responsible for validating that source and destination paths
//! are within allowed directories. Consider using:
//!
//! - `std::fs::canonicalize()` to resolve symlinks and ".." components
//! - Path prefix checking to ensure paths remain within a sandbox directory
//! - Chroot or namespace isolation for additional protection
//!
//! Example of caller-side path validation:
//! ```ignore
//! use std::path::Path;
//!
//! fn validate_path_in_sandbox(path: &Path, sandbox: &Path) -> bool {
//!     match path.canonicalize() {
//!         Ok(canonical) => canonical.starts_with(sandbox),
//!         Err(_) => false, // Path doesn't exist or other error
//!     }
//! }
//! ```
//!
//! ## Errno Race Condition Fix (macOS)
//!
//! On macOS, errno is captured immediately after syscall using `__error()`
//! to prevent TOCTOU (Time-of-Check to Time-of-Use) race conditions where
//! errno could be modified by signal handlers or other threads.
//!
//! ## OWASP References
//!
//! - A01:2021 - Broken Access Control: File type validation, path security
//! - A04:2021 - Insecure Design: Errno race condition prevention

#![deny(clippy::all)]

// This crate only supports macOS and Linux
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
compile_error!("This crate only supports macOS and Linux");

mod error;

#[cfg(target_os = "macos")]
mod darwin;

#[cfg(target_os = "linux")]
mod linux;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::Path;

#[cfg(target_os = "macos")]
use darwin as platform;

#[cfg(target_os = "linux")]
use linux as platform;

/// Clone a file or directory synchronously using native Copy-on-Write
///
/// - macOS: Uses clonefile() which supports both files and directories
/// - Linux: Uses FICLONE ioctl which only supports files
#[napi]
pub fn clone_sync(src: String, dest: String) -> Result<()> {
    platform::clone_file(Path::new(&src), Path::new(&dest)).map_err(|e| e.into())
}

/// Clone a file or directory asynchronously using native Copy-on-Write
///
/// - macOS: Uses clonefile() which supports both files and directories
/// - Linux: Uses FICLONE ioctl which only supports files
#[napi]
pub async fn clone_async(src: String, dest: String) -> Result<()> {
    // Run the blocking operation in a separate thread pool
    let result = tokio::task::spawn_blocking(move || {
        platform::clone_file(Path::new(&src), Path::new(&dest))
    })
    .await
    .map_err(|e| napi::Error::new(Status::GenericFailure, e.to_string()))?;

    result.map_err(|e| e.into())
}

/// Clone a file or directory synchronously (alias for cloneSync for backward compatibility)
#[napi]
pub fn clone(src: String, dest: String) -> Result<()> {
    clone_sync(src, dest)
}

/// Check if native clone operations are available
#[napi]
pub fn is_available() -> bool {
    platform::is_available()
}

/// Check if directory cloning is supported
/// - macOS clonefile: true (supports directories)
/// - Linux FICLONE: false (files only)
#[napi]
pub fn supports_directory() -> bool {
    platform::supports_directory()
}

/// Get the current platform
/// Returns "darwin", "linux", or "unknown"
#[napi]
pub fn get_platform() -> String {
    platform::get_platform().to_string()
}
