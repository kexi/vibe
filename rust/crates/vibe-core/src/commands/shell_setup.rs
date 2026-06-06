//! `vibe shell-setup`: print the shell wrapper function (+ optional completion).
//!
//! Ported from `packages/core/src/commands/shell-setup.ts`. Detects the shell
//! from `--shell` or `$SHELL`, prints the `eval`-able wrapper function to stdout
//! and, with `--with-completion`, appends the shell's completion script. Each
//! piece is emitted via `console.log` in the TS (one trailing newline each); the
//! [`Outcome::stdout`] string reproduces that exactly.

use crate::commands::Outcome;
use crate::completion::{generate_fish_completion, generate_zsh_completion};
use crate::error::{Result, VibeError};
use crate::io::Io;
use crate::output::{verbose_log, OutputOptions};

/// Supported shells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellName {
    Bash,
    Zsh,
    Fish,
    Nushell,
    Powershell,
}

impl ShellName {
    fn as_str(self) -> &'static str {
        match self {
            ShellName::Bash => "bash",
            ShellName::Zsh => "zsh",
            ShellName::Fish => "fish",
            ShellName::Nushell => "nushell",
            ShellName::Powershell => "powershell",
        }
    }
}

/// Detect a shell from a path/name (e.g. `/bin/zsh` → `Zsh`).
fn detect_shell(shell_path: &str) -> Option<ShellName> {
    let basename = shell_path.rsplit('/').next().unwrap_or(shell_path);
    match basename.to_ascii_lowercase().as_str() {
        "bash" => Some(ShellName::Bash),
        "zsh" => Some(ShellName::Zsh),
        "fish" => Some(ShellName::Fish),
        "nu" | "nushell" => Some(ShellName::Nushell),
        "pwsh" | "powershell" => Some(ShellName::Powershell),
        _ => None,
    }
}

/// The wrapper function definition for a shell.
fn shell_function(shell: ShellName) -> &'static str {
    match shell {
        ShellName::Bash | ShellName::Zsh => r#"vibe() { eval "$(command vibe "$@")"; }"#,
        ShellName::Fish => "function vibe; eval (command vibe $argv); end",
        ShellName::Nushell => {
            "def --env vibe [...args] { ^vibe ...$args | lines | each { |line| nu -c $line } }"
        }
        ShellName::Powershell => "function vibe { Invoke-Expression (& vibe.exe $args) }",
    }
}

/// The completion generator for a shell, if `--with-completion` is supported.
fn completion_generator(shell: ShellName) -> Option<fn() -> String> {
    match shell {
        ShellName::Fish => Some(generate_fish_completion),
        ShellName::Zsh => Some(generate_zsh_completion),
        _ => None,
    }
}

/// Run `vibe shell-setup`.
///
/// `shell_override` is the `--shell` flag value; `with_completion` is the
/// `--with-completion` flag. `$SHELL` is read from the [`Io`] when no override.
pub fn shell_setup_command(
    io: &impl Io,
    shell_override: Option<&str>,
    with_completion: bool,
    opts: OutputOptions,
) -> Result<Outcome> {
    let shell_env = shell_override
        .map(|s| s.to_string())
        .or_else(|| io.env("SHELL"))
        .unwrap_or_default();

    let Some(shell) = detect_shell(&shell_env) else {
        // The binary's `report_error` prints `Error: <msg>` and exits 1. We do
        // NOT pre-print here (that would double the message), and we use a
        // fatal (exit-1) error rather than `Argument` (exit-2) to match the TS
        // `runtime.control.exit(1)`. The message omits the leading `Error: `
        // because the error formatter adds it.
        return Err(VibeError::Configuration(
            "Could not detect shell. Set $SHELL or use --shell <bash|zsh|fish|nushell|powershell>."
                .to_string(),
        ));
    };

    let generator = completion_generator(shell);
    let completion_unsupported = with_completion && generator.is_none();
    if completion_unsupported {
        // Supported completion shells, sorted (TS sorted the map keys).
        let mut supported = ["fish", "zsh"];
        supported.sort_unstable();
        return Err(VibeError::Configuration(format!(
            "--with-completion currently supports only: {} (got {}).",
            supported.join(", "),
            shell.as_str()
        )));
    }

    verbose_log(io, &format!("Detected shell: {}", shell.as_str()), opts);

    // Reproduce the TS two `console.log` calls: each appends a newline.
    let mut out = String::new();
    out.push_str(shell_function(shell));
    out.push('\n');
    if let (true, Some(generate)) = (with_completion, generator) {
        out.push_str(&generate());
        out.push('\n');
    }

    Ok(Outcome::stdout(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::FakeIo;

    #[test]
    fn detects_shell_from_path_basename() {
        assert_eq!(detect_shell("/bin/zsh"), Some(ShellName::Zsh));
        assert_eq!(detect_shell("/usr/bin/fish"), Some(ShellName::Fish));
        assert_eq!(detect_shell("nu"), Some(ShellName::Nushell));
        assert_eq!(detect_shell("pwsh"), Some(ShellName::Powershell));
        assert_eq!(detect_shell("/bin/tcsh"), None);
    }

    #[test]
    fn prints_bash_wrapper_function() {
        let io = FakeIo::new().with_env("SHELL", "/bin/bash");
        let out = shell_setup_command(&io, None, false, OutputOptions::default()).unwrap();
        assert_eq!(
            out.stdout.as_deref(),
            Some("vibe() { eval \"$(command vibe \"$@\")\"; }\n")
        );
        assert_eq!(out.cd_path, None);
    }

    #[test]
    fn shell_override_takes_precedence_over_env() {
        let io = FakeIo::new().with_env("SHELL", "/bin/bash");
        let out = shell_setup_command(&io, Some("fish"), false, OutputOptions::default()).unwrap();
        assert_eq!(
            out.stdout.as_deref(),
            Some("function vibe; eval (command vibe $argv); end\n")
        );
    }

    #[test]
    fn unknown_shell_errors() {
        let io = FakeIo::new().with_env("SHELL", "/bin/tcsh");
        let err = shell_setup_command(&io, None, false, OutputOptions::default()).unwrap_err();
        // exit code 1 (not 2), and the message carries the hint; the binary's
        // report_error prints it once (no pre-print here, so stderr is empty).
        assert_eq!(err.exit_code(), 1);
        assert!(err.to_string().contains("Could not detect shell"));
        assert!(io.stderr_text().is_empty());
    }

    #[test]
    fn with_completion_appends_fish_script() {
        let io = FakeIo::new();
        let out = shell_setup_command(&io, Some("fish"), true, OutputOptions::default()).unwrap();
        let stdout = out.stdout.unwrap();
        assert!(stdout.starts_with("function vibe; eval (command vibe $argv); end\n"));
        assert!(stdout.contains("# vibe fish completion"));
    }

    #[test]
    fn with_completion_unsupported_shell_errors() {
        let io = FakeIo::new().with_env("SHELL", "/bin/bash");
        let err = shell_setup_command(&io, None, true, OutputOptions::default()).unwrap_err();
        assert_eq!(err.exit_code(), 1);
        assert!(err
            .to_string()
            .contains("--with-completion currently supports only"));
    }

    #[test]
    fn prints_zsh_wrapper_byte_exact() {
        let io = FakeIo::new();
        let out = shell_setup_command(&io, Some("zsh"), false, OutputOptions::default()).unwrap();
        // zsh shares the POSIX wrapper with bash, byte-for-byte vs the TS string.
        assert_eq!(
            out.stdout.as_deref(),
            Some("vibe() { eval \"$(command vibe \"$@\")\"; }\n")
        );
        assert_eq!(out.cd_path, None);
    }

    #[test]
    fn prints_nushell_wrapper_byte_exact() {
        let io = FakeIo::new();
        let out =
            shell_setup_command(&io, Some("nushell"), false, OutputOptions::default()).unwrap();
        assert_eq!(
            out.stdout.as_deref(),
            Some("def --env vibe [...args] { ^vibe ...$args | lines | each { |line| nu -c $line } }\n")
        );
    }

    #[test]
    fn prints_powershell_wrapper_byte_exact() {
        let io = FakeIo::new();
        let out =
            shell_setup_command(&io, Some("powershell"), false, OutputOptions::default()).unwrap();
        assert_eq!(
            out.stdout.as_deref(),
            Some("function vibe { Invoke-Expression (& vibe.exe $args) }\n")
        );
    }

    #[test]
    fn zsh_with_completion_appends_zsh_script() {
        let io = FakeIo::new();
        let out = shell_setup_command(&io, Some("zsh"), true, OutputOptions::default()).unwrap();
        let stdout = out.stdout.unwrap();
        // Wrapper first, then the zsh completion (zsh IS a supported completion).
        assert!(stdout.starts_with("vibe() { eval \"$(command vibe \"$@\")\"; }\n"));
        assert!(stdout.contains("#compdef vibe"));
    }

    #[test]
    fn nushell_with_completion_is_unsupported_with_sorted_list_and_shell_name() {
        let io = FakeIo::new();
        let err =
            shell_setup_command(&io, Some("nushell"), true, OutputOptions::default()).unwrap_err();
        assert_eq!(err.exit_code(), 1);
        let msg = err.to_string();
        // The sorted supported list (fish, zsh) and the offending shell name.
        assert!(msg.contains("only: fish, zsh"), "got: {msg}");
        assert!(msg.contains("(got nushell)"), "got: {msg}");
    }

    #[test]
    fn powershell_with_completion_is_unsupported_with_shell_name() {
        let io = FakeIo::new();
        let err = shell_setup_command(&io, Some("powershell"), true, OutputOptions::default())
            .unwrap_err();
        assert_eq!(err.exit_code(), 1);
        let msg = err.to_string();
        assert!(msg.contains("only: fish, zsh"), "got: {msg}");
        assert!(msg.contains("(got powershell)"), "got: {msg}");
    }

    #[test]
    fn no_shell_flag_and_unset_env_is_unknown_and_errors() {
        // No `--shell` override AND no `$SHELL` in the env → detection fails.
        let io = FakeIo::new(); // empty env: SHELL unset
        let err = shell_setup_command(&io, None, false, OutputOptions::default()).unwrap_err();
        assert_eq!(err.exit_code(), 1);
        assert!(err.to_string().contains("Could not detect shell"));
        // No pre-print: the binary's report_error owns the single stderr write.
        assert!(io.stderr_text().is_empty());
    }
}
