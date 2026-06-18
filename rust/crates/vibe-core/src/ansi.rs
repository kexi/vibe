//! ANSI color codes and color-support detection.
//!
//! Ported from `packages/core/src/utils/ansi.ts`. The raw escape sequences must
//! match the TS exactly so colored stderr output is byte-identical. Detection
//! follows the same precedence (`FORCE_COLOR` > `NO_COLOR` > stderr-is-a-tty),
//! but reads those signals through the injected [`Io`] instead of `process.env`
//! / `process.stderr.isTTY`, so tests can force either outcome without touching
//! the real environment.

use crate::io::Io;

pub const RED: &str = "\x1b[31m";
pub const GREEN: &str = "\x1b[32m";
pub const YELLOW: &str = "\x1b[33m";
pub const DIM: &str = "\x1b[2m";
pub const RESET: &str = "\x1b[0m";

/// Whether color output is enabled, per the TS `detectColorSupport` precedence.
///
/// Why not cache globally like the TS `_colorEnabled`: the value is derived from
/// the injected [`Io`], so callers compute it once per command run and pass the
/// boolean down. No process-global state keeps the functions pure and testable.
pub fn is_color_enabled(io: &impl Io) -> bool {
    let force_color = io.env("FORCE_COLOR").is_some();
    if force_color {
        return true;
    }
    let no_color = io.env("NO_COLOR").is_some();
    if no_color {
        return false;
    }
    io.is_stderr_terminal()
}

/// Wrap `message` with `color` + reset when `enabled`, else return it unchanged.
pub fn colorize(color: &str, message: &str, enabled: bool) -> String {
    if !enabled {
        return message.to_string();
    }
    format!("{color}{message}{RESET}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::FakeIo;

    #[test]
    fn force_color_overrides_everything() {
        let io = FakeIo::new().with_env("FORCE_COLOR", "1").stderr_tty(false);
        assert!(is_color_enabled(&io));
    }

    #[test]
    fn no_color_disables_when_not_forced() {
        let io = FakeIo::new().with_env("NO_COLOR", "1").stderr_tty(true);
        assert!(!is_color_enabled(&io));
    }

    #[test]
    fn falls_back_to_stderr_tty() {
        assert!(is_color_enabled(&FakeIo::new().stderr_tty(true)));
        assert!(!is_color_enabled(&FakeIo::new().stderr_tty(false)));
    }

    #[test]
    fn force_color_wins_over_no_color() {
        let io = FakeIo::new()
            .with_env("FORCE_COLOR", "1")
            .with_env("NO_COLOR", "1");
        assert!(is_color_enabled(&io));
    }

    #[test]
    fn colorize_wraps_only_when_enabled() {
        assert_eq!(colorize(RED, "hi", true), "\x1b[31mhi\x1b[0m");
        assert_eq!(colorize(RED, "hi", false), "hi");
    }
}
