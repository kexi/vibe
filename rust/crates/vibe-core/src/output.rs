//! Leveled logging to stderr (`log` / `verbose_log` / `success_log` / ...).
//!
//! Ported from `packages/core/src/utils/output.ts`. stdout is reserved for the
//! eval'd `cd` contract, so every human-facing message goes to stderr. The
//! quiet/verbose gating and the color choice per level reproduce the TS
//! behavior exactly; output is routed through the injected [`Io`] so tests can
//! capture it.

use crate::ansi::{colorize, is_color_enabled, DIM, GREEN, RED, YELLOW};
use crate::io::Io;

/// Verbosity flags, mirroring the TS `OutputOptions`.
#[derive(Debug, Clone, Copy, Default)]
pub struct OutputOptions {
    pub verbose: bool,
    pub quiet: bool,
}

impl OutputOptions {
    pub fn new(verbose: bool, quiet: bool) -> Self {
        OutputOptions { verbose, quiet }
    }
}

/// Log a plain message to stderr unless quiet.
pub fn log(io: &impl Io, message: &str, opts: OutputOptions) {
    if opts.quiet {
        return;
    }
    io.writeln_stderr(message);
}

/// Log a `[verbose] `-prefixed message, only when verbose && !quiet.
pub fn verbose_log(io: &impl Io, message: &str, opts: OutputOptions) {
    let should_log = opts.verbose && !opts.quiet;
    if !should_log {
        return;
    }
    io.writeln_stderr(&format!("[verbose] {message}"));
}

/// Log a green success message to stderr unless quiet.
pub fn success_log(io: &impl Io, message: &str, opts: OutputOptions) {
    if opts.quiet {
        return;
    }
    let colored = colorize(GREEN, message, is_color_enabled(io));
    io.writeln_stderr(&colored);
}

/// Log a red error message to stderr. Always prints (never suppressed by quiet).
pub fn error_log(io: &impl Io, message: &str) {
    let colored = colorize(RED, message, is_color_enabled(io));
    io.writeln_stderr(&colored);
}

/// Log a yellow warning to stderr. Always prints (never suppressed by quiet).
pub fn warn_log(io: &impl Io, message: &str) {
    let colored = colorize(YELLOW, message, is_color_enabled(io));
    io.writeln_stderr(&colored);
}

/// Log an uncolored diagnostic line to stderr. Always prints (never suppressed
/// by quiet).
///
/// Why not `log`: a command whose entire purpose IS the report (`doctor`) would
/// exit non-zero in total silence under `--quiet`, which is unexplainable. Why
/// not `warn_log`: painting a clean report yellow makes a passing check look like
/// a problem, so the color stays reserved for the actual findings.
pub fn report_log(io: &impl Io, message: &str) {
    io.writeln_stderr(message);
}

/// Log a dim `[dry-run] `-prefixed message to stderr. Always prints (never
/// suppressed by quiet), matching the TS `logDryRun`.
pub fn log_dry_run(io: &impl Io, message: &str) {
    let colored = colorize(DIM, &format!("[dry-run] {message}"), is_color_enabled(io));
    io.writeln_stderr(&colored);
}

/// Make an attacker-influenced path safe to print on a terminal.
///
/// Replaces every terminal-control character with U+FFFD: C0/C1 controls and
/// ESC (which could otherwise reposition the cursor, clear the line, or emit a
/// forged status line), the Unicode line separators, and the bidi
/// override/isolate codepoints (which can visually reverse a path so a file in
/// one directory renders as if it were in another).
///
/// Why replace rather than strip: stripping collapses two genuinely different
/// paths into the same rendering, so a report line could name an innocent file
/// while describing a different one. A U+FFFD keeps the strings distinct and
/// makes the tampering visible.
///
/// Scope: applied by `doctor` (whose paths are built straight from environment
/// variables) and by the copy layer (`copy_runner`, `git_copy`), whose file names
/// come from `git ls-files` and are therefore chosen by whoever can land a file
/// in the repository. The remaining stderr paths (`fast_remove`, the rest of
/// `start`) do their own stripping/rejecting and have NOT been migrated onto this
/// helper, so its use is not yet a program-wide guarantee.
pub fn sanitize_for_display(text: &str) -> String {
    text.chars()
        .map(|c| {
            let is_unsafe = c.is_control()
                || matches!(c, '\u{2028}' | '\u{2029}')
                || ('\u{200e}'..='\u{200f}').contains(&c)
                || ('\u{202a}'..='\u{202e}').contains(&c)
                || ('\u{2066}'..='\u{2069}').contains(&c);
            if is_unsafe {
                '\u{fffd}'
            } else {
                c
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::FakeIo;

    fn opts(verbose: bool, quiet: bool) -> OutputOptions {
        OutputOptions::new(verbose, quiet)
    }

    #[test]
    fn log_suppressed_by_quiet() {
        let io = FakeIo::new();
        log(&io, "hi", opts(false, true));
        assert!(io.stderr.borrow().is_empty());
    }

    #[test]
    fn log_prints_when_not_quiet() {
        let io = FakeIo::new();
        log(&io, "hi", opts(false, false));
        assert_eq!(io.stderr_text(), "hi");
    }

    #[test]
    fn verbose_log_only_when_verbose_and_not_quiet() {
        let io = FakeIo::new();
        verbose_log(&io, "x", opts(false, false));
        assert!(io.stderr.borrow().is_empty());

        verbose_log(&io, "y", opts(true, true));
        assert!(io.stderr.borrow().is_empty());

        verbose_log(&io, "z", opts(true, false));
        assert_eq!(io.stderr_text(), "[verbose] z");
    }

    #[test]
    fn error_and_warn_print_even_when_quiet() {
        let io = FakeIo::new();
        // No tty / no FORCE_COLOR → no color codes, so assert raw text.
        error_log(&io, "boom");
        warn_log(&io, "careful");
        assert_eq!(io.stderr_text(), "boom\ncareful");
    }

    #[test]
    fn log_dry_run_prefixes_and_prints_even_when_color_disabled() {
        let io = FakeIo::new();
        log_dry_run(&io, "Would run: git branch -m a b");
        assert_eq!(io.stderr_text(), "[dry-run] Would run: git branch -m a b");
    }

    #[test]
    fn log_dry_run_is_dim_when_color_enabled() {
        let io = FakeIo::new().with_env("FORCE_COLOR", "1");
        log_dry_run(&io, "x");
        assert_eq!(io.stderr_text(), "\x1b[2m[dry-run] x\x1b[0m");
    }

    #[test]
    fn report_log_prints_uncolored_even_when_quiet_and_color_enabled() {
        let io = FakeIo::new().with_env("FORCE_COLOR", "1");
        report_log(&io, "checked: current");
        assert_eq!(io.stderr_text(), "checked: current");
    }

    #[test]
    fn sanitize_replaces_escape_and_newline_but_keeps_length() {
        let out = sanitize_for_display("/tmp/a\x1b[2Kb\nc");
        assert_eq!(out, "/tmp/a\u{fffd}[2Kb\u{fffd}c");
    }

    #[test]
    fn sanitize_replaces_bidi_and_line_separators() {
        for bad in ['\u{202e}', '\u{2066}', '\u{200f}', '\u{2028}', '\u{2029}'] {
            let out = sanitize_for_display(&format!("/tmp/{bad}x"));
            assert_eq!(out, "/tmp/\u{fffd}x", "not sanitized: {:?}", bad);
        }
    }

    #[test]
    fn sanitize_leaves_ordinary_paths_untouched() {
        // Including non-ASCII, which is legitimate in a path.
        let path = "/home/ユーザー/.config/nushell/config.nu";
        assert_eq!(sanitize_for_display(path), path);
    }

    #[test]
    fn sanitize_keeps_distinct_paths_distinct() {
        // Stripping would render both as `/tmp/ab`; replacing must not.
        assert_ne!(
            sanitize_for_display("/tmp/a\u{202e}b"),
            sanitize_for_display("/tmp/ab")
        );
    }

    #[test]
    fn success_log_is_green_when_color_enabled() {
        let io = FakeIo::new().with_env("FORCE_COLOR", "1");
        success_log(&io, "ok", opts(false, false));
        assert_eq!(io.stderr_text(), "\x1b[32mok\x1b[0m");
    }
}
