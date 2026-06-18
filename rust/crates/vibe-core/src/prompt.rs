//! Interactive confirm / select prompts.
//!
//! Ported from `packages/core/src/utils/prompt.ts`. The trait lets `jump` (and
//! later commands) be tested with a scripted [`FakePrompt`]; [`RealPrompt`]
//! drives the real terminal through the injected [`Io`]. Interactivity is gated
//! the same way as the TS: forced on by `VIBE_FORCE_INTERACTIVE=1`, otherwise it
//! requires a stdin tty.

use crate::error::{Result, VibeError};
use crate::io::Io;

/// Y/n confirmation and numbered selection prompts.
pub trait Prompt {
    /// Show a Y/n prompt; `true` for yes. Non-interactive → `false`.
    fn confirm(&self, message: &str) -> bool;

    /// Show a numbered choice list; returns the selected 0-based index.
    /// Non-interactive → `Err` (matches the TS `throw`).
    fn select(&self, message: &str, choices: &[String]) -> Result<usize>;
}

/// Production [`Prompt`] over the injected [`Io`].
pub struct RealPrompt<'a, I: Io> {
    io: &'a I,
}

impl<'a, I: Io> RealPrompt<'a, I> {
    pub fn new(io: &'a I) -> Self {
        RealPrompt { io }
    }

    fn is_interactive(&self) -> bool {
        self.io.force_interactive() || self.io.is_stdin_terminal()
    }
}

impl<I: Io> Prompt for RealPrompt<'_, I> {
    fn confirm(&self, message: &str) -> bool {
        if !self.is_interactive() {
            // Non-interactive: auto-decline, matching prompt.ts.
            self.io.writeln_stderr(
                "Error: Cannot run in non-interactive mode with uncommitted changes.",
            );
            return false;
        }

        loop {
            self.io.writeln_stderr(message);
            let Some(input) = self.io.read_line() else {
                return false; // EOF → No.
            };

            // Empty or starts with y/Y → yes; n/N → no; else reprompt.
            let is_yes = input.is_empty() || input == "Y" || input == "y";
            if is_yes {
                return true;
            }
            let is_no = input == "N" || input == "n";
            if is_no {
                return false;
            }
            self.io
                .writeln_stderr("Invalid input. Please enter Y/y/n/N.");
        }
    }

    fn select(&self, message: &str, choices: &[String]) -> Result<usize> {
        if !self.is_interactive() {
            return Err(VibeError::Argument(
                "Cannot run select() in non-interactive mode".to_string(),
            ));
        }

        loop {
            self.io.writeln_stderr(message);
            for (i, choice) in choices.iter().enumerate() {
                self.io.writeln_stderr(&format!("  {}. {choice}", i + 1));
            }
            self.io.writeln_stderr("Please select (enter number):");

            let Some(input) = self.io.read_line() else {
                // EOF → last choice (usually Cancel), matching prompt.ts.
                return Ok(choices.len().saturating_sub(1));
            };

            let parsed = input.parse::<usize>().ok();
            let is_valid = parsed.is_some_and(|n| n >= 1 && n <= choices.len());
            if is_valid {
                return Ok(parsed.unwrap() - 1);
            }
            self.io.writeln_stderr(&format!(
                "Invalid input. Please enter a number between 1 and {}.",
                choices.len()
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::FakeIo;

    fn prompt_io(stdin: &[&str], interactive: bool) -> FakeIo {
        FakeIo::new().with_stdin(stdin).stdin_tty(interactive)
    }

    #[test]
    fn confirm_yes_on_empty_or_y() {
        for line in ["", "y", "Y"] {
            let io = prompt_io(&[line], true);
            assert!(RealPrompt::new(&io).confirm("ok?"));
        }
    }

    #[test]
    fn confirm_no_on_n() {
        let io = prompt_io(&["n"], true);
        assert!(!RealPrompt::new(&io).confirm("ok?"));
    }

    #[test]
    fn confirm_reprompts_on_invalid_then_accepts() {
        let io = prompt_io(&["maybe", "y"], true);
        assert!(RealPrompt::new(&io).confirm("ok?"));
        assert!(io.stderr_text().contains("Invalid input"));
    }

    #[test]
    fn confirm_eof_is_no() {
        let io = prompt_io(&[], true);
        assert!(!RealPrompt::new(&io).confirm("ok?"));
    }

    #[test]
    fn confirm_non_interactive_is_no() {
        let io = prompt_io(&["y"], false); // tty off, no force.
        assert!(!RealPrompt::new(&io).confirm("ok?"));
    }

    #[test]
    fn confirm_force_interactive_overrides_tty() {
        let io = FakeIo::new()
            .with_stdin(&["y"])
            .stdin_tty(false)
            .with_env("VIBE_FORCE_INTERACTIVE", "1");
        assert!(RealPrompt::new(&io).confirm("ok?"));
    }

    #[test]
    fn select_returns_zero_based_index() {
        let io = prompt_io(&["2"], true);
        let choices = vec!["a".into(), "b".into(), "Cancel".into()];
        assert_eq!(RealPrompt::new(&io).select("pick", &choices).unwrap(), 1);
    }

    #[test]
    fn select_reprompts_out_of_range() {
        let io = prompt_io(&["9", "1"], true);
        let choices = vec!["a".into(), "Cancel".into()];
        assert_eq!(RealPrompt::new(&io).select("pick", &choices).unwrap(), 0);
    }

    #[test]
    fn select_eof_returns_last_choice() {
        let io = prompt_io(&[], true);
        let choices = vec!["a".into(), "b".into(), "Cancel".into()];
        assert_eq!(RealPrompt::new(&io).select("pick", &choices).unwrap(), 2);
    }

    #[test]
    fn select_non_interactive_errors() {
        let io = prompt_io(&["1"], false);
        let choices = vec!["a".into(), "Cancel".into()];
        assert!(RealPrompt::new(&io).select("pick", &choices).is_err());
    }
}
