//! macOS implementation using clonefile() syscall
//!
//! clonefile() creates a copy-on-write clone on APFS filesystems.
//! Supports both files and directories.
//!
//! # Security Considerations
//!
//! This module implements several security measures:
//!
//! - **File type validation**: Only regular files and directories are allowed.
//!   Symlinks, device files, sockets, and FIFOs are rejected to prevent:
//!   - Symlink attacks (CWE-59, CWE-61)
//!   - Device file access escalation
//!   - Socket/FIFO exploitation
//!
//! - **Immediate errno capture**: Uses libc's __error() to capture errno
//!   immediately after syscall to prevent TOCTOU race conditions.
//!
//! # OWASP References
//! - A01:2021 - Broken Access Control (file type validation)
//! - A04:2021 - Insecure Design (errno race condition fix)

use crate::error::{CloneError, CloneResult};
use std::ffi::CString;
use std::fs;
use std::os::unix::fs::FileTypeExt;
use std::path::Path;

extern "C" {
    fn clonefile(src: *const libc::c_char, dst: *const libc::c_char, flags: u32) -> libc::c_int;
    // SECURITY: Use __error() to get errno pointer immediately after syscall
    // This prevents race conditions where errno could be modified by signal handlers
    // or other threads between the syscall and error capture.
    fn __error() -> *mut libc::c_int;
}

/// Capture errno immediately using libc's __error() function.
/// This is safer than std::io::Error::last_os_error() as it avoids
/// potential race conditions in multi-threaded environments.
///
/// # Safety
/// This function calls the C library function __error() which returns
/// a pointer to the thread-local errno value.
#[inline]
fn capture_errno() -> i32 {
    // SAFETY: __error() returns a valid pointer to thread-local errno
    unsafe { *__error() }
}

/// Validate that the source path points to a supported file type.
/// Only regular files and directories are allowed for security reasons.
///
/// # Security
/// Rejects symlinks, device files, sockets, and FIFOs to prevent:
/// - Symlink following attacks (CWE-59)
/// - Access to device files (could leak system information)
/// - Socket/FIFO manipulation
fn validate_file_type(path: &Path) -> CloneResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|e| {
        CloneError::from_errno("stat", e.raw_os_error().unwrap_or(0))
    })?;
    let file_type = metadata.file_type();

    // SECURITY: Only allow regular files and directories
    let is_regular_file = file_type.is_file();
    let is_directory = file_type.is_dir();

    if is_regular_file || is_directory {
        return Ok(());
    }

    // Determine the file type for error message
    let type_name = if file_type.is_symlink() {
        "symlink"
    } else if file_type.is_block_device() {
        "block device"
    } else if file_type.is_char_device() {
        "character device"
    } else if file_type.is_fifo() {
        "FIFO (named pipe)"
    } else if file_type.is_socket() {
        "socket"
    } else {
        "unknown"
    };

    Err(CloneError::UnsupportedFileType { file_type: type_name })
}

fn path_to_cstring(path: &Path) -> CloneResult<CString> {
    let path_str = path.to_str().ok_or(CloneError::InvalidUtf8)?;
    let is_empty = path_str.is_empty();
    if is_empty {
        return Err(CloneError::EmptyPath);
    }
    CString::new(path_str).map_err(|_| CloneError::NullByte)
}

/// Clone a file or directory using macOS clonefile()
///
/// # Security
/// - Validates source file type before cloning (rejects symlinks, devices, etc.)
/// - Captures errno immediately after syscall to prevent race conditions
pub fn clone_file(src: &Path, dest: &Path) -> CloneResult<()> {
    // SECURITY: Validate file type before cloning
    // This prevents symlink attacks, device file access, and socket/FIFO exploitation
    validate_file_type(src)?;

    let src_cstr = path_to_cstring(src)?;
    let dest_cstr = path_to_cstring(dest)?;

    let result = unsafe { clonefile(src_cstr.as_ptr(), dest_cstr.as_ptr(), 0) };

    if result != 0 {
        // SECURITY: Capture errno immediately after syscall using __error()
        // This prevents TOCTOU race conditions where errno could be modified
        // by signal handlers or other threads between syscall and error capture
        let errno = capture_errno();
        return Err(CloneError::from_errno("clonefile", errno));
    }

    Ok(())
}

/// Check if clonefile is available (always true on macOS 10.12+)
pub fn is_available() -> bool {
    true
}

/// Check if directory cloning is supported (true for clonefile)
pub fn supports_directory() -> bool {
    true
}

/// Get platform name
pub fn get_platform() -> &'static str {
    "darwin"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    #[test]
    fn test_is_available() {
        assert!(is_available());
    }

    #[test]
    fn test_supports_directory() {
        assert!(supports_directory());
    }

    #[test]
    fn test_get_platform() {
        assert_eq!(get_platform(), "darwin");
    }

    #[test]
    fn test_clone_file() {
        let temp_dir = TempDir::new().unwrap();
        let src = temp_dir.path().join("src.txt");
        let dest = temp_dir.path().join("dest.txt");

        // Create source file
        fs::write(&src, "test content").unwrap();

        // Clone
        let result = clone_file(&src, &dest);

        // APFS is required for clonefile to work
        // On other filesystems, it may fail with ENOTSUP
        match result {
            Ok(()) => {
                // Success - file was cloned
                let content = fs::read_to_string(&dest).unwrap();
                assert_eq!(content, "test content");
            }
            Err(CloneError::SystemError { errno, .. }) if errno == libc::ENOTSUP => {
                // Not supported on this filesystem - acceptable
            }
            Err(e) => panic!("Unexpected error: {:?}", e),
        }
        // TempDir automatically cleans up on drop
    }

    // SECURITY TESTS: Verify file type validation

    #[test]
    fn test_reject_symlink() {
        let temp_dir = TempDir::new().unwrap();
        let src = temp_dir.path().join("src.txt");
        let link = temp_dir.path().join("link.txt");
        let dest = temp_dir.path().join("dest.txt");

        // Create source file and symlink
        fs::write(&src, "test content").unwrap();
        symlink(&src, &link).unwrap();

        // Attempt to clone symlink should fail
        let result = clone_file(&link, &dest);

        match result {
            Err(CloneError::UnsupportedFileType { file_type }) => {
                assert_eq!(file_type, "symlink");
            }
            _ => panic!("Expected UnsupportedFileType error for symlink"),
        }
    }

    #[test]
    fn test_clone_directory() {
        let temp_dir = TempDir::new().unwrap();
        let src_dir = temp_dir.path().join("src_dir");
        let dest_dir = temp_dir.path().join("dest_dir");

        // Create source directory
        fs::create_dir(&src_dir).unwrap();

        // Clone directory
        let result = clone_file(&src_dir, &dest_dir);

        // APFS is required for clonefile to work
        match result {
            Ok(()) => {
                assert!(dest_dir.is_dir());
            }
            Err(CloneError::SystemError { errno, .. }) if errno == libc::ENOTSUP => {
                // Not supported on this filesystem - acceptable
            }
            Err(e) => panic!("Unexpected error: {:?}", e),
        }
    }

    #[test]
    fn test_validate_file_type_regular_file() {
        let temp_dir = TempDir::new().unwrap();
        let src = temp_dir.path().join("src.txt");
        fs::write(&src, "test").unwrap();

        assert!(validate_file_type(&src).is_ok());
    }

    #[test]
    fn test_validate_file_type_directory() {
        let temp_dir = TempDir::new().unwrap();
        let dir = temp_dir.path().join("dir");
        fs::create_dir(&dir).unwrap();

        assert!(validate_file_type(&dir).is_ok());
    }

    #[test]
    fn test_validate_file_type_symlink() {
        let temp_dir = TempDir::new().unwrap();
        let src = temp_dir.path().join("src.txt");
        let link = temp_dir.path().join("link.txt");

        fs::write(&src, "test").unwrap();
        symlink(&src, &link).unwrap();

        let result = validate_file_type(&link);
        assert!(matches!(
            result,
            Err(CloneError::UnsupportedFileType { file_type: "symlink" })
        ));
    }
}
