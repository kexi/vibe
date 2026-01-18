//! Error types for native clone operations

use napi::bindgen_prelude::*;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum CloneError {
    #[error("{operation} failed: {message} (errno {errno})")]
    SystemError {
        operation: &'static str,
        message: String,
        errno: i32,
    },

    #[error("Path is empty")]
    EmptyPath,

    #[error("Path contains invalid UTF-8")]
    InvalidUtf8,

    #[error("Path contains null bytes")]
    NullByte,

    // SECURITY: Prevents cloning of symlinks, device files, sockets, and FIFOs
    // OWASP A01:2021 - Broken Access Control
    #[error("Unsupported file type: {file_type} (only regular files and directories are allowed)")]
    UnsupportedFileType { file_type: &'static str },
}

impl CloneError {
    pub fn from_errno(operation: &'static str, errno: i32) -> Self {
        let message = std::io::Error::from_raw_os_error(errno).to_string();
        Self::SystemError {
            operation,
            message,
            errno,
        }
    }
}

impl From<CloneError> for napi::Error {
    fn from(err: CloneError) -> Self {
        // err.to_string() already includes errno for SystemError variants,
        // so we don't need to append it again
        napi::Error::new(Status::GenericFailure, err.to_string())
    }
}

pub type CloneResult<T> = std::result::Result<T, CloneError>;
