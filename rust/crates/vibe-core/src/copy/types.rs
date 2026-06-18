//! Copy strategy identifiers and the copy error type.

use std::fmt;

/// The concrete copy mechanism a [`super::CopyExecutor`] selected.
///
/// Ported from the TS `CopyStrategyType` union
/// (`"clonefile" | "clone" | "rsync" | "robocopy" | "standard"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyStrategyKind {
    /// Native `clonefile`/`FICLONE` via vibe-native.
    Clonefile,
    /// `cp -c` (macOS) / `cp --reflink=auto` (Linux).
    Clone,
    /// `rsync -a`.
    Rsync,
    /// `robocopy /MT` (Windows).
    Robocopy,
    /// Plain `std::fs` copy.
    Standard,
}

impl CopyStrategyKind {
    /// The lowercase name used in progress labels / debug output (TS parity).
    pub fn name(self) -> &'static str {
        match self {
            CopyStrategyKind::Clonefile => "clonefile",
            CopyStrategyKind::Clone => "clone",
            CopyStrategyKind::Rsync => "rsync",
            CopyStrategyKind::Robocopy => "robocopy",
            CopyStrategyKind::Standard => "standard",
        }
    }
}

impl fmt::Display for CopyStrategyKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// An error from a copy unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopyError {
    /// A path failed `validate_path` (null/newline/empty/`$(`/backtick).
    InvalidPath(String),
    /// A copy command/syscall failed with this message.
    Failed(String),
    /// The native clone rejected an unsupported file type (symlink/device/...).
    /// SECURITY (finding #5): this must NOT trigger a fallback to cp/standard.
    UnsupportedFileType(String),
}

impl fmt::Display for CopyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CopyError::InvalidPath(m) => write!(f, "{m}"),
            CopyError::Failed(m) => write!(f, "{m}"),
            CopyError::UnsupportedFileType(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for CopyError {}

pub type CopyResult<T> = std::result::Result<T, CopyError>;

/// Validate a path for use in a copy command (defense in depth, even with `--`).
///
/// This is the SINGLE authoritative path-safety check shared across the
/// codebase: the untrusted-stdin boundary ([`crate::stdin::validate_path`])
/// delegates here so the two security boundaries can never silently diverge.
///
/// Ported from `packages/core/src/utils/copy/validation.ts` `validatePath`:
/// rejects null bytes, newlines (`\n`/`\r`), an empty/whitespace-only path, and
/// shell command-substitution patterns (`$(` / backtick).
pub fn validate_path(path: &str) -> CopyResult<()> {
    if path.contains('\0') {
        return Err(CopyError::InvalidPath(
            "Invalid path: contains null byte".to_string(),
        ));
    }
    if path.contains('\n') || path.contains('\r') {
        return Err(CopyError::InvalidPath(
            "Invalid path: contains newline characters".to_string(),
        ));
    }
    if path.trim().is_empty() {
        return Err(CopyError::InvalidPath(
            "Invalid path: path is empty".to_string(),
        ));
    }
    if path.contains("$(") || path.contains('`') {
        return Err(CopyError::InvalidPath(
            "Invalid path: contains shell command substitution pattern".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strategy_names_match_ts() {
        assert_eq!(CopyStrategyKind::Clonefile.name(), "clonefile");
        assert_eq!(CopyStrategyKind::Clone.name(), "clone");
        assert_eq!(CopyStrategyKind::Rsync.name(), "rsync");
        assert_eq!(CopyStrategyKind::Robocopy.name(), "robocopy");
        assert_eq!(CopyStrategyKind::Standard.name(), "standard");
    }

    #[test]
    fn validate_path_rejects_dangerous_inputs() {
        assert!(validate_path("ok/path").is_ok());
        assert!(matches!(
            validate_path("a\0b"),
            Err(CopyError::InvalidPath(_))
        ));
        assert!(matches!(
            validate_path("a\nb"),
            Err(CopyError::InvalidPath(_))
        ));
        assert!(matches!(
            validate_path("a\rb"),
            Err(CopyError::InvalidPath(_))
        ));
        assert!(matches!(
            validate_path("   "),
            Err(CopyError::InvalidPath(_))
        ));
        assert!(matches!(
            validate_path("$(whoami)"),
            Err(CopyError::InvalidPath(_))
        ));
        assert!(matches!(
            validate_path("a`id`b"),
            Err(CopyError::InvalidPath(_))
        ));
    }
}
