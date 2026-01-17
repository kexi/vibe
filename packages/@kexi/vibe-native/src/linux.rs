//! Linux implementation using FICLONE ioctl
//!
//! FICLONE creates a copy-on-write clone on filesystems that support it
//! (Btrfs, XFS with reflink support). Only works for regular files.
//!
//! # Security Considerations
//!
//! This module implements several security measures:
//!
//! - **File type validation**: Only regular files are allowed.
//!   Symlinks, device files, sockets, FIFOs, and directories are rejected to prevent:
//!   - Symlink attacks (CWE-59, CWE-61)
//!   - Device file access escalation
//!   - Socket/FIFO exploitation
//!
//! Note: FICLONE only supports regular files, so directory cloning is not available.
//!
//! # OWASP References
//! - A01:2021 - Broken Access Control (file type validation)

use crate::error::{CloneError, CloneResult};
use std::fs::{self, File, OpenOptions};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::Path;

// FICLONE ioctl request code
nix::ioctl_write_int!(ficlone, 0x94, 9);

/// Validate that the source path points to a regular file.
/// Only regular files are allowed for FICLONE.
///
/// # Security
/// Rejects symlinks, device files, sockets, FIFOs, and directories to prevent:
/// - Symlink following attacks (CWE-59)
/// - Access to device files (could leak system information)
/// - Socket/FIFO manipulation
fn validate_file_type(path: &Path) -> CloneResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|e| {
        CloneError::from_errno("stat", e.raw_os_error().unwrap_or(0))
    })?;
    let file_type = metadata.file_type();

    // SECURITY: Only allow regular files (FICLONE does not support directories)
    let is_regular_file = file_type.is_file();

    if is_regular_file {
        return Ok(());
    }

    // Determine the file type for error message
    let type_name = if file_type.is_symlink() {
        "symlink"
    } else if file_type.is_dir() {
        "directory"
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

fn validate_path(path: &Path) -> CloneResult<()> {
    let path_str = path.to_str().ok_or(CloneError::InvalidUtf8)?;
    let is_empty = path_str.is_empty();
    if is_empty {
        return Err(CloneError::EmptyPath);
    }
    Ok(())
}

/// Clone a file using Linux FICLONE ioctl
///
/// # Security
/// - Validates source file type before cloning (rejects symlinks, devices, etc.)
pub fn clone_file(src: &Path, dest: &Path) -> CloneResult<()> {
    validate_path(src)?;
    validate_path(dest)?;

    // SECURITY: Validate file type before cloning
    // This prevents symlink attacks, device file access, and socket/FIFO exploitation
    validate_file_type(src)?;

    // Open source file for reading
    let src_file = File::open(src).map_err(|e| {
        CloneError::from_errno("open source", e.raw_os_error().unwrap_or(0))
    })?;

    // Get source file permissions to preserve them
    let src_metadata = std::fs::metadata(src).map_err(|e| {
        CloneError::from_errno("stat source", e.raw_os_error().unwrap_or(0))
    })?;
    let src_mode = src_metadata.permissions().mode();

    // Create/open destination file for writing with source permissions
    let dest_file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(src_mode)
        .open(dest)
        .map_err(|e| {
            CloneError::from_errno("open dest", e.raw_os_error().unwrap_or(0))
        })?;

    // Perform FICLONE ioctl
    let result = unsafe { ficlone(dest_file.as_raw_fd(), src_file.as_raw_fd() as i32) };

    if let Err(errno) = result {
        // Remove partially created destination file on failure
        let _ = std::fs::remove_file(dest);
        let errno_value: i32 = errno.into();
        return Err(CloneError::from_errno("ioctl FICLONE", errno_value));
    }

    Ok(())
}

/// Check if FICLONE is available
/// We assume it's available if we're on Linux; actual support depends on filesystem
pub fn is_available() -> bool {
    true
}

/// Check if directory cloning is supported (false for FICLONE)
pub fn supports_directory() -> bool {
    false
}

/// Get platform name
pub fn get_platform() -> &'static str {
    "linux"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;
    use tempfile::TempDir;

    #[test]
    fn test_is_available() {
        assert!(is_available());
    }

    #[test]
    fn test_supports_directory() {
        assert!(!supports_directory());
    }

    #[test]
    fn test_get_platform() {
        assert_eq!(get_platform(), "linux");
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

        // Btrfs/XFS with reflink is required for FICLONE to work
        // On other filesystems, it may fail with EOPNOTSUPP
        match result {
            Ok(()) => {
                // Success - file was cloned
                let content = fs::read_to_string(&dest).unwrap();
                assert_eq!(content, "test content");
            }
            Err(CloneError::SystemError { errno, .. })
                if errno == libc::EOPNOTSUPP || errno == libc::ENOTSUP =>
            {
                // Not supported on this filesystem - acceptable
            }
            Err(e) => panic!("Unexpected error: {:?}", e),
        }
        // TempDir automatically cleans up on drop
    }

    #[test]
    fn test_empty_source_path() {
        let temp_dir = TempDir::new().unwrap();
        let empty_path = PathBuf::from("");
        let dest = temp_dir.path().join("dest.txt");

        let result = clone_file(&empty_path, &dest);
        let is_empty_path_error = matches!(result, Err(CloneError::EmptyPath));
        assert!(is_empty_path_error, "Expected EmptyPath error");
    }

    #[test]
    fn test_empty_dest_path() {
        let temp_dir = TempDir::new().unwrap();
        let src = temp_dir.path().join("src.txt");
        let empty_path = PathBuf::from("");

        // Create source file
        fs::write(&src, "test content").unwrap();

        let result = clone_file(&src, &empty_path);
        let is_empty_path_error = matches!(result, Err(CloneError::EmptyPath));
        assert!(is_empty_path_error, "Expected EmptyPath error");
    }

    #[test]
    fn test_source_not_found() {
        let temp_dir = TempDir::new().unwrap();
        let nonexistent = temp_dir.path().join("nonexistent.txt");
        let dest = temp_dir.path().join("dest.txt");

        let result = clone_file(&nonexistent, &dest);
        let is_system_error = matches!(
            result,
            Err(CloneError::SystemError { errno, .. }) if errno == libc::ENOENT
        );
        assert!(is_system_error, "Expected ENOENT error for missing source");
    }

    #[test]
    fn test_permission_denied_on_dest() {
        let temp_dir = TempDir::new().unwrap();
        let src = temp_dir.path().join("src.txt");

        // Create source file
        fs::write(&src, "test content").unwrap();

        // Try to write to a read-only directory
        let readonly_dir = temp_dir.path().join("readonly");
        fs::create_dir(&readonly_dir).unwrap();

        // Make directory read-only
        let mut perms = fs::metadata(&readonly_dir).unwrap().permissions();
        perms.set_mode(0o444);
        fs::set_permissions(&readonly_dir, perms).unwrap();

        let dest = readonly_dir.join("dest.txt");
        let result = clone_file(&src, &dest);

        // Restore permissions for cleanup
        let mut perms = fs::metadata(&readonly_dir).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&readonly_dir, perms).unwrap();

        let is_permission_error = matches!(
            result,
            Err(CloneError::SystemError { errno, .. }) if errno == libc::EACCES
        );
        assert!(
            is_permission_error,
            "Expected EACCES error for permission denied"
        );
    }

    #[test]
    fn test_clone_preserves_permissions() {
        let temp_dir = TempDir::new().unwrap();
        let src = temp_dir.path().join("src.txt");
        let dest = temp_dir.path().join("dest.txt");

        // Create source file with specific permissions (executable)
        fs::write(&src, "test content").unwrap();
        let mut perms = fs::metadata(&src).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&src, perms).unwrap();

        let result = clone_file(&src, &dest);

        match result {
            Ok(()) => {
                // Verify permissions are preserved
                let src_mode = fs::metadata(&src).unwrap().permissions().mode();
                let dest_mode = fs::metadata(&dest).unwrap().permissions().mode();
                assert_eq!(
                    src_mode & 0o777,
                    dest_mode & 0o777,
                    "Permissions should be preserved"
                );
            }
            Err(CloneError::SystemError { errno, .. })
                if errno == libc::EOPNOTSUPP || errno == libc::ENOTSUP =>
            {
                // Not supported on this filesystem - acceptable
            }
            Err(e) => panic!("Unexpected error: {:?}", e),
        }
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
    fn test_reject_directory() {
        let temp_dir = TempDir::new().unwrap();
        let src_dir = temp_dir.path().join("src_dir");
        let dest_dir = temp_dir.path().join("dest_dir");

        // Create source directory
        fs::create_dir(&src_dir).unwrap();

        // Attempt to clone directory should fail (FICLONE only supports files)
        let result = clone_file(&src_dir, &dest_dir);

        match result {
            Err(CloneError::UnsupportedFileType { file_type }) => {
                assert_eq!(file_type, "directory");
            }
            _ => panic!("Expected UnsupportedFileType error for directory"),
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

    #[test]
    fn test_validate_file_type_directory() {
        let temp_dir = TempDir::new().unwrap();
        let dir = temp_dir.path().join("dir");
        fs::create_dir(&dir).unwrap();

        let result = validate_file_type(&dir);
        assert!(matches!(
            result,
            Err(CloneError::UnsupportedFileType { file_type: "directory" })
        ));
    }
}
