//! Read + validate untrusted stdin JSON for the Claude-Code hook modes.
//!
//! Ported from `packages/core/src/utils/stdin.ts` (SECURITY: this is the
//! untrusted-input boundary). [`read_stdin_json`] reads ≤1 MB and stops as soon
//! as the cap is exceeded (does NOT keep buffering), parsing only a JSON OBJECT.
//! [`read_worktree_hook_name`] and [`read_worktree_hook_path`] extract + validate
//! the two hook fields. Two HARDENING divergences from the TS (security #3):
//!
//! - the hook NAME additionally rejects a leading `-` (prevents git-flag
//!   injection like `-b <name>` / `--force` flowing into `git worktree add`), and
//! - paths go through [`validate_path`] (null/newline/empty/`$(`/backtick) on top
//!   of the absolute-path requirement.
//!
//! Reading stdin is injected via a [`StdinReader`] so the cap / parsing / field
//! validation are unit-testable without a real pipe.

use crate::io::Io;
use crate::output::warn_log;
use serde_json::{Map, Value};
use std::path::Path;

/// 1 MB cap on the stdin payload (resource-exhaustion guard).
pub const MAX_STDIN_SIZE: usize = 1024 * 1024;

/// Reads the raw stdin payload (so tests can inject bytes). Returns `None` when
/// stdin is interactive / unavailable.
pub trait StdinReader {
    /// Read up to `max + 1` bytes from stdin. Returning more than `max` signals
    /// the cap was exceeded. `None` when interactive (a tty).
    fn read_capped(&self, max: usize) -> Option<Vec<u8>>;
}

/// Production [`StdinReader`] over real stdin.
pub struct RealStdinReader<'a, I: Io> {
    io: &'a I,
}

impl<'a, I: Io> RealStdinReader<'a, I> {
    pub fn new(io: &'a I) -> Self {
        RealStdinReader { io }
    }
}

impl<I: Io> StdinReader for RealStdinReader<'_, I> {
    fn read_capped(&self, max: usize) -> Option<Vec<u8>> {
        use std::io::Read;
        // Interactive stdin has no piped JSON.
        if self.io.is_stdin_terminal() {
            return None;
        }
        // Read at most max+1 bytes: if we get max+1, the caller knows the cap was
        // exceeded WITHOUT having buffered the entire (possibly huge) payload.
        let mut buf = Vec::new();
        let stdin = std::io::stdin();
        let mut handle = stdin.lock().take((max as u64) + 1);
        if handle.read_to_end(&mut buf).is_err() {
            return None;
        }
        Some(buf)
    }
}

/// Read and parse a JSON OBJECT from stdin (≤1 MB). `None` on no/over-cap/invalid
/// input or a non-object JSON value.
pub fn read_stdin_json(io: &impl Io, reader: &impl StdinReader) -> Option<Map<String, Value>> {
    let bytes = reader.read_capped(MAX_STDIN_SIZE)?;

    if bytes.len() > MAX_STDIN_SIZE {
        warn_log(
            io,
            &format!("Warning: stdin payload exceeds {MAX_STDIN_SIZE} bytes, ignoring."),
        );
        return None;
    }
    if bytes.is_empty() {
        return None;
    }

    let text = String::from_utf8_lossy(&bytes);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Parse to a JSON OBJECT only (reject arrays / scalars / null).
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// Read `{name}` (WorktreeCreate hook). `None` unless it is a non-empty string
/// with no null byte and NO leading `-` (security #3 git-flag-injection guard).
pub fn read_worktree_hook_name(io: &impl Io, reader: &impl StdinReader) -> Option<String> {
    let json = read_stdin_json(io, reader)?;
    let name = json.get("name")?.as_str()?;
    if name.is_empty() {
        return None;
    }
    // Defense in depth: reject null bytes (git rejects these too).
    if name.contains('\0') {
        return None;
    }
    // SECURITY #3 (divergence from TS): reject a leading dash so a name like
    // `--force` / `-b` cannot be smuggled into a `git worktree add` flag slot.
    if name.starts_with('-') {
        return None;
    }
    Some(name.to_string())
}

/// Read `{worktree_path}` (WorktreeRemove hook). `None` unless it is a non-empty
/// ABSOLUTE string that also passes [`validate_path`].
pub fn read_worktree_hook_path(io: &impl Io, reader: &impl StdinReader) -> Option<String> {
    let json = read_stdin_json(io, reader)?;
    let path = json.get("worktree_path")?.as_str()?;
    if path.is_empty() {
        return None;
    }
    if !Path::new(path).is_absolute() {
        return None;
    }
    if validate_path(path).is_err() {
        return None;
    }
    Some(path.to_string())
}

/// Validate a path from untrusted stdin: reject null/newline(`\n`/`\r`)/empty/
/// shell command-substitution (`$(`/backtick).
///
/// Delegates to the SINGLE authoritative check [`crate::copy::validate_path`] so
/// the copy boundary and this stdin boundary can never diverge; we only adapt
/// the error type (copy's `CopyError` → this boundary's `String`), preserving
/// the identical rejection messages.
pub fn validate_path(path: &str) -> Result<(), String> {
    crate::copy::validate_path(path).map_err(|e| e.to_string())
}

#[cfg(any(test, feature = "test-util"))]
pub use fake::FakeStdin;

#[cfg(any(test, feature = "test-util"))]
mod fake {
    use super::StdinReader;

    /// A [`StdinReader`] serving fixed bytes (or `None` for an interactive/empty
    /// stdin), and honoring the cap exactly like the real reader.
    pub struct FakeStdin {
        bytes: Option<Vec<u8>>,
    }

    impl FakeStdin {
        /// Serve `text` as the stdin payload.
        pub fn text(text: &str) -> Self {
            FakeStdin {
                bytes: Some(text.as_bytes().to_vec()),
            }
        }
        /// Serve raw bytes.
        pub fn bytes(bytes: Vec<u8>) -> Self {
            FakeStdin { bytes: Some(bytes) }
        }
        /// Interactive / no input.
        pub fn none() -> Self {
            FakeStdin { bytes: None }
        }
    }

    impl StdinReader for FakeStdin {
        fn read_capped(&self, max: usize) -> Option<Vec<u8>> {
            let bytes = self.bytes.as_ref()?;
            // Mirror the real reader: hand back at most max+1 bytes so the caller
            // can detect the cap was exceeded without buffering everything.
            let take = (max + 1).min(bytes.len());
            Some(bytes[..take].to_vec())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::FakeIo;

    #[test]
    fn parses_a_json_object() {
        let io = FakeIo::new();
        let r = FakeStdin::text(r#"{"name": "feature-auth"}"#);
        let map = read_stdin_json(&io, &r).unwrap();
        assert_eq!(map.get("name").unwrap().as_str(), Some("feature-auth"));
    }

    #[test]
    fn rejects_non_object_json() {
        let io = FakeIo::new();
        assert!(read_stdin_json(&io, &FakeStdin::text("[1,2,3]")).is_none());
        assert!(read_stdin_json(&io, &FakeStdin::text("42")).is_none());
        assert!(read_stdin_json(&io, &FakeStdin::text("null")).is_none());
        assert!(read_stdin_json(&io, &FakeStdin::text("not json")).is_none());
    }

    #[test]
    fn empty_and_whitespace_input_is_none() {
        let io = FakeIo::new();
        assert!(read_stdin_json(&io, &FakeStdin::text("")).is_none());
        assert!(read_stdin_json(&io, &FakeStdin::text("   \n  ")).is_none());
        assert!(read_stdin_json(&io, &FakeStdin::none()).is_none());
    }

    #[test]
    fn enforces_1mb_cap_without_buffering_more() {
        let io = FakeIo::new();
        // A payload one byte over the cap is rejected with a warning.
        let big = "x".repeat(MAX_STDIN_SIZE + 100);
        let r = FakeStdin::text(&format!("\"{big}\""));
        assert!(read_stdin_json(&io, &r).is_none());
        assert!(io.stderr_text().contains("exceeds"));
    }

    // --- read_worktree_hook_name ---

    #[test]
    fn reads_valid_name() {
        let io = FakeIo::new();
        let r = FakeStdin::text(r#"{"name": "my-feature", "extra": 1}"#);
        assert_eq!(
            read_worktree_hook_name(&io, &r),
            Some("my-feature".to_string())
        );
    }

    #[test]
    fn name_missing_or_empty_or_wrong_type_is_none() {
        let io = FakeIo::new();
        assert!(read_worktree_hook_name(&io, &FakeStdin::text(r#"{"other": 1}"#)).is_none());
        assert!(read_worktree_hook_name(&io, &FakeStdin::text(r#"{"name": ""}"#)).is_none());
        assert!(read_worktree_hook_name(&io, &FakeStdin::text(r#"{"name": 5}"#)).is_none());
    }

    // SECURITY #3: leading-dash name rejection (git-flag injection guard).
    #[test]
    fn leading_dash_name_is_rejected() {
        let io = FakeIo::new();
        assert!(read_worktree_hook_name(&io, &FakeStdin::text(r#"{"name": "--force"}"#)).is_none());
        assert!(read_worktree_hook_name(&io, &FakeStdin::text(r#"{"name": "-b"}"#)).is_none());
        // A name that merely contains a dash later is fine.
        assert_eq!(
            read_worktree_hook_name(&io, &FakeStdin::text(r#"{"name": "feat-x"}"#)),
            Some("feat-x".to_string())
        );
    }

    #[test]
    fn null_byte_name_is_rejected() {
        let io = FakeIo::new();
        let r = FakeStdin::text("{\"name\": \"a\u{0}b\"}");
        assert!(read_worktree_hook_name(&io, &r).is_none());
    }

    // --- read_worktree_hook_path ---

    #[test]
    fn reads_valid_absolute_path() {
        let io = FakeIo::new();
        let r = FakeStdin::text(r#"{"worktree_path": "/home/u/wt"}"#);
        assert_eq!(
            read_worktree_hook_path(&io, &r),
            Some("/home/u/wt".to_string())
        );
    }

    #[test]
    fn relative_path_is_rejected() {
        let io = FakeIo::new();
        let r = FakeStdin::text(r#"{"worktree_path": "relative/wt"}"#);
        assert!(read_worktree_hook_path(&io, &r).is_none());
    }

    #[test]
    fn path_failing_validate_path_is_rejected() {
        let io = FakeIo::new();
        // Absolute but contains a command-substitution pattern.
        let r = FakeStdin::text(r#"{"worktree_path": "/tmp/$(whoami)"}"#);
        assert!(read_worktree_hook_path(&io, &r).is_none());
    }

    #[test]
    fn validate_path_rejects_dangerous() {
        assert!(validate_path("/ok/path").is_ok());
        assert!(validate_path("/a\0b").is_err());
        assert!(validate_path("/a\nb").is_err());
        assert!(validate_path("   ").is_err());
        assert!(validate_path("/a`id`").is_err());
    }

    // Guard the dedup: this stdin boundary must stay byte-for-byte identical to
    // the authoritative copy `validate_path` (it now delegates to it).
    #[test]
    fn validate_path_messages_match_copy_authority() {
        for bad in ["/a\0b", "/a\nb", "/a\rb", "   ", "/a`id`", "/$(whoami)"] {
            let here = validate_path(bad).unwrap_err();
            let copy = crate::copy::validate_path(bad).unwrap_err().to_string();
            assert_eq!(here, copy, "divergence for input {bad:?}");
        }
        assert!(validate_path("/ok/path").is_ok());
        assert!(crate::copy::validate_path("/ok/path").is_ok());
    }
}
