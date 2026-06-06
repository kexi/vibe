//! Unified error type for the vibe CLI.
//!
//! Ported from `packages/core/src/errors/index.ts`. The TypeScript code modeled
//! each error as a subclass of `VibeError` carrying a `severity` and `exitCode`;
//! here we collapse that hierarchy into a single enum whose variants reproduce
//! the same messages, severities and exit codes so the CLI's observable
//! behavior (exit status + stderr text) stays identical.

use std::fmt;

/// Error severity, mirroring `ErrorSeverity` in the TS code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Fatal,
    Warning,
    Info,
}

/// All errors surfaced by the vibe CLI.
#[derive(Debug, thiserror::Error)]
pub enum VibeError {
    /// User cancelled the operation (Ctrl+C or declined a confirmation).
    #[error("{0}")]
    UserCancelled(String),

    /// A `git` invocation failed. Message format: `git <command>: <message>`.
    #[error("git {command}: {message}")]
    GitOperation { command: String, message: String },

    /// Configuration file parsing/validation error.
    #[error("{0}")]
    Configuration(String),

    /// File system operation error.
    #[error("{0}")]
    FileSystem(String),

    /// Worktree operation error.
    #[error("{0}")]
    Worktree(String),

    /// Hook execution failure. Non-fatal: warns and continues (exit code 0).
    #[error("Hook \"{hook_command}\" failed: {message}")]
    HookExecution {
        hook_command: String,
        message: String,
    },

    /// Command argument error (exit code 2).
    #[error("{0}")]
    Argument(String),

    /// Network operation error.
    #[error("{0}")]
    Network(String),

    /// Trust/security verification error. Message format: `<file_path>: <message>`.
    #[error("{file_path}: {message}")]
    Trust { file_path: String, message: String },

    /// A fatal error whose diagnostics were ALREADY written to stderr by the
    /// command itself (e.g. `trust` prints a multi-line "Failed to trust …"
    /// block via `error_log`, which has no `Error:` prefix). The binary must NOT
    /// print anything further for this; it only carries the exit code. Mirrors a
    /// TS command that called its own `errorLog(...)` then `exit(1)`.
    #[error("")]
    AlreadyReported,
}

impl VibeError {
    /// Construct a `UserCancelled` error with the default message.
    pub fn cancelled() -> Self {
        VibeError::UserCancelled("Operation cancelled".to_string())
    }

    /// Severity level, matching the TS `severity` field per subclass.
    pub fn severity(&self) -> Severity {
        match self {
            VibeError::UserCancelled(_) => Severity::Info,
            VibeError::HookExecution { .. } => Severity::Warning,
            _ => Severity::Fatal,
        }
    }

    /// Process exit code, matching the TS `exitCode` field per subclass.
    pub fn exit_code(&self) -> i32 {
        match self {
            VibeError::UserCancelled(_) => 130,
            VibeError::HookExecution { .. } => 0,
            VibeError::Argument(_) => 2,
            _ => 1,
        }
    }
}

/// Result alias used throughout the core library.
pub type Result<T> = std::result::Result<T, VibeError>;

/// Format the single stderr line for an error, or `None` when nothing should be
/// printed (so the binary owns the actual write — see `format_error_message`'s
/// callers — keeping vibe-core free of stderr side-effects and the formatting
/// unit-testable).
///
/// Mirrors `handleError`/`handleVibeError` in `errors/handler.ts`:
/// - `quiet` → `None` (suppress all output).
/// - `UserCancelled` with the default `"Operation cancelled"` message → `None`
///   (silent), but a custom message → `Some(message)` (no prefix).
/// - `HookExecution` (warning severity) → `Some("Warning: <msg>")`.
/// - everything else → `Some("Error: <msg>")`.
///
/// The exit code is independent of whether a line is printed; obtain it from
/// [`VibeError::exit_code`]. Coloring is applied by the caller's output layer, so
/// this keeps the prefix logic only.
pub fn format_error_message(error: &VibeError, quiet: bool) -> Option<String> {
    if quiet {
        return None;
    }

    match error {
        // Diagnostics already written by the command; print nothing further.
        VibeError::AlreadyReported => None,
        VibeError::UserCancelled(message) => {
            if message == "Operation cancelled" {
                return None; // Default cancel message stays silent.
            }
            Some(message.clone())
        }
        _ => {
            let prefix = match error.severity() {
                Severity::Warning => "Warning",
                _ => "Error",
            };
            Some(format!("{prefix}: {error}"))
        }
    }
}

// Note: there is intentionally no stderr-writing `handle_error` here. The
// binary owns the actual write (`main.rs::report_error`) via an injected `Io`,
// using `format_error_message` + `VibeError::exit_code`, so vibe-core stays free
// of stderr side-effects on the error path.

impl fmt::Display for Severity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Severity::Fatal => "fatal",
            Severity::Warning => "warning",
            Severity::Info => "info",
        };
        f.write_str(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_operation_message_format() {
        let err = VibeError::GitOperation {
            command: "worktree add".into(),
            message: "fatal: boom".into(),
        };
        assert_eq!(err.to_string(), "git worktree add: fatal: boom");
        assert_eq!(err.exit_code(), 1);
        assert_eq!(err.severity(), Severity::Fatal);
    }

    #[test]
    fn argument_error_exit_code_is_2() {
        let err = VibeError::Argument("bad flag".into());
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn user_cancelled_exit_code_is_130_and_info() {
        let err = VibeError::cancelled();
        assert_eq!(err.exit_code(), 130);
        assert_eq!(err.severity(), Severity::Info);
    }

    #[test]
    fn hook_execution_is_warning_with_exit_0() {
        let err = VibeError::HookExecution {
            hook_command: "npm install".into(),
            message: "exit 1".into(),
        };
        assert_eq!(err.exit_code(), 0);
        assert_eq!(err.severity(), Severity::Warning);
        assert_eq!(err.to_string(), "Hook \"npm install\" failed: exit 1");
    }

    #[test]
    fn trust_error_message_format() {
        let err = VibeError::Trust {
            file_path: ".vibe.toml".into(),
            message: "hash mismatch".into(),
        };
        assert_eq!(err.to_string(), ".vibe.toml: hash mismatch");
    }

    #[test]
    fn format_fatal_error_uses_error_prefix() {
        let err = VibeError::FileSystem("disk gone".into());
        assert_eq!(
            format_error_message(&err, false).as_deref(),
            Some("Error: disk gone")
        );
        // Exit-code parity is independent of the printed line.
        assert_eq!(err.exit_code(), 1);
    }

    #[test]
    fn format_warning_error_uses_warning_prefix() {
        let err = VibeError::HookExecution {
            hook_command: "npm install".into(),
            message: "exit 1".into(),
        };
        assert_eq!(
            format_error_message(&err, false).as_deref(),
            Some("Warning: Hook \"npm install\" failed: exit 1")
        );
        assert_eq!(err.exit_code(), 0);
    }

    #[test]
    fn format_quiet_suppresses_message_but_not_exit_code() {
        let err = VibeError::Argument("bad flag".into());
        assert_eq!(format_error_message(&err, true), None);
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn format_user_cancelled_default_is_silent() {
        let err = VibeError::cancelled();
        assert_eq!(format_error_message(&err, false), None);
        assert_eq!(err.exit_code(), 130);
    }

    #[test]
    fn format_user_cancelled_custom_message_is_shown_without_prefix() {
        let err = VibeError::UserCancelled("Declined the prompt".into());
        assert_eq!(
            format_error_message(&err, false).as_deref(),
            Some("Declined the prompt")
        );
        assert_eq!(err.exit_code(), 130);
    }
}
