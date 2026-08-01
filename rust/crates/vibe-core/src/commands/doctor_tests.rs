//! Unit tests for `vibe doctor`.
//!
//! Guarantees: the candidate profile set is derived only from validated env
//! roots; the classifier recognizes the real pre-2.2.0 wrappers as stale and the
//! shipped wrappers as current (drift-guarded against `shell_setup`); the report
//! exits 1 only on a stale finding and stays visible under `--quiet`.

use super::*;
use crate::commands::shell_setup::shell_function;
use crate::io::FakeIo;
use std::collections::BTreeMap;

/// The pre-2.2.0 wrapper texts, recovered from git history (the commit before
/// `feat: emit shell-dialect-aware eval output via --eval-dialect`). These are
/// the exact strings a user may still have pasted in an rc file.
const OLD_NU_WRAPPER: &str =
    "def --env vibe [...args] { ^vibe ...$args | lines | each { |line| nu -c $line } }";
const OLD_PWSH_WRAPPER: &str = "function vibe { Invoke-Expression (& vibe.exe $args) }";

/// A scripted [`ProfileFs`]: any path not in the map is `Missing`.
#[derive(Default)]
struct FakeProfileFs {
    entries: BTreeMap<PathBuf, ProfileRead>,
}

impl FakeProfileFs {
    fn new() -> Self {
        FakeProfileFs::default()
    }

    fn with_content(mut self, path: &str, content: &str) -> Self {
        self.entries.insert(
            PathBuf::from(path),
            ProfileRead::Present {
                content: content.to_string(),
                truncated: false,
            },
        );
        self
    }

    fn with_truncated(mut self, path: &str, content: &str) -> Self {
        self.entries.insert(
            PathBuf::from(path),
            ProfileRead::Present {
                content: content.to_string(),
                truncated: true,
            },
        );
        self
    }

    fn with_read(mut self, path: &str, read: ProfileRead) -> Self {
        self.entries.insert(PathBuf::from(path), read);
        self
    }
}

impl ProfileFs for FakeProfileFs {
    fn read_profile(&self, path: &Path) -> ProfileRead {
        self.entries
            .get(path)
            .cloned()
            .unwrap_or(ProfileRead::Missing)
    }
}

/// The unix platform (the default), for the candidate-path cases.
const UNIX: HostPlatform = HostPlatform {
    is_windows: false,
    is_macos: false,
};
const MACOS: HostPlatform = HostPlatform {
    is_windows: false,
    is_macos: true,
};
const WINDOWS: HostPlatform = HostPlatform {
    is_windows: true,
    is_macos: false,
};

fn paths(io: &FakeIo, platform: HostPlatform) -> Vec<String> {
    candidate_profiles(io, platform)
        .profiles
        .into_iter()
        .map(|(_, p)| p.to_string_lossy().replace('\\', "/"))
        .collect()
}

fn skipped(io: &FakeIo, platform: HostPlatform) -> Vec<&'static str> {
    candidate_profiles(io, platform).skipped_roots
}

// --- candidate_profiles: env matrix ---

#[test]
fn unix_defaults_to_home_dot_config() {
    let io = FakeIo::new().with_env("HOME", "/home/u");
    assert_eq!(
        paths(&io, UNIX),
        vec![
            "/home/u/.config/nushell/config.nu",
            "/home/u/.config/powershell/Microsoft.PowerShell_profile.ps1",
            "/home/u/.config/powershell/profile.ps1",
        ]
    );
}

#[test]
fn xdg_redirects_both_shells_to_exactly_one_root() {
    // Each shell resolves ONE config dir. For PowerShell that is .NET's
    // `ApplicationData`, which on Unix is XDG_CONFIG_HOME when set and `~/.config`
    // otherwise — the same rule nu follows, so no `~/.config` candidate is probed
    // while XDG is set.
    let io = FakeIo::new()
        .with_env("HOME", "/home/u")
        .with_env("XDG_CONFIG_HOME", "/xdg");
    assert_eq!(
        paths(&io, UNIX),
        vec![
            "/xdg/nushell/config.nu",
            "/xdg/powershell/Microsoft.PowerShell_profile.ps1",
            "/xdg/powershell/profile.ps1",
        ]
    );
}

#[test]
fn powershell_falls_back_to_dot_config_when_xdg_is_unset() {
    let io = FakeIo::new().with_env("HOME", "/home/u");
    assert_eq!(
        paths(&io, UNIX),
        vec![
            "/home/u/.config/nushell/config.nu",
            "/home/u/.config/powershell/Microsoft.PowerShell_profile.ps1",
            "/home/u/.config/powershell/profile.ps1",
        ]
    );
}

#[test]
fn a_stale_powershell_leftover_under_home_is_ignored_when_xdg_points_elsewhere() {
    // The inverse of the previous policy: with XDG set, `~/.config/powershell` is
    // not the directory PowerShell loads, so a stale file there is inert and must
    // not fail the run.
    let io = FakeIo::new()
        .with_env("HOME", "/home/u")
        .with_env("XDG_CONFIG_HOME", "/xdg");
    let fs = FakeProfileFs::new()
        .with_content("/home/u/.config/powershell/profile.ps1", OLD_PWSH_WRAPPER);
    let outcome = doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    assert!(!io.stderr_text().contains("stale"));
}

#[test]
fn a_stale_powershell_profile_under_dot_config_is_found_when_xdg_is_unset() {
    let io = unix_io();
    let fs = FakeProfileFs::new()
        .with_content("/home/u/.config/powershell/profile.ps1", OLD_PWSH_WRAPPER);
    let err = doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap_err();
    assert_eq!(err.exit_code(), 1);
    assert!(io
        .stderr_text()
        .contains("/home/u/.config/powershell/profile.ps1: stale"));
}

#[test]
fn unix_with_no_home_at_all_has_no_candidates() {
    let io = FakeIo::new();
    assert!(paths(&io, UNIX).is_empty());
}

#[test]
fn unsafe_env_roots_are_rejected() {
    // Relative, `..`-bearing and empty roots are all refused, and with no safe
    // fallback the candidate list is empty (never a path built from them).
    for bad in ["relative/config", "/home/../etc", ""] {
        let io = FakeIo::new().with_env("XDG_CONFIG_HOME", bad);
        assert!(
            paths(&io, UNIX).is_empty(),
            "unsafe XDG_CONFIG_HOME accepted: {bad:?}"
        );
    }
}

#[test]
fn unsafe_xdg_falls_back_to_a_safe_home() {
    let io = FakeIo::new()
        .with_env("XDG_CONFIG_HOME", "../evil")
        .with_env("HOME", "/home/u");
    assert_eq!(
        paths(&io, UNIX),
        vec![
            "/home/u/.config/nushell/config.nu",
            "/home/u/.config/powershell/Microsoft.PowerShell_profile.ps1",
            "/home/u/.config/powershell/profile.ps1",
        ]
    );
}

#[test]
fn unix_dotdot_substring_in_a_directory_name_is_allowed() {
    // `a..b` is one legitimate segment, not a parent-dir reference.
    let io = FakeIo::new().with_env("HOME", "/home/a..b");
    assert!(paths(&io, UNIX)
        .iter()
        .any(|p| p == "/home/a..b/.config/nushell/config.nu"));
}

#[cfg(windows)]
#[test]
fn windows_uses_appdata_and_userprofile_documents() {
    let io = FakeIo::new()
        .with_env("APPDATA", r"C:\Users\u\AppData\Roaming")
        .with_env("USERPROFILE", r"C:\Users\u");
    assert_eq!(
        paths(&io, WINDOWS),
        vec![
            "C:/Users/u/AppData/Roaming/nushell/config.nu",
            "C:/Users/u/Documents/PowerShell/Microsoft.PowerShell_profile.ps1",
            "C:/Users/u/Documents/PowerShell/profile.ps1",
            "C:/Users/u/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1",
            "C:/Users/u/Documents/WindowsPowerShell/profile.ps1",
        ]
    );
}

#[cfg(windows)]
#[test]
fn windows_also_probes_onedrive_documents_when_set() {
    let io = FakeIo::new()
        .with_env("USERPROFILE", r"C:\Users\u")
        .with_env("OneDrive", r"C:\Users\u\OneDrive");
    let found = paths(&io, WINDOWS);
    assert!(found
        .iter()
        .any(|p| p == "C:/Users/u/OneDrive/Documents/PowerShell/profile.ps1"));
}

#[cfg(windows)]
#[test]
fn windows_rejects_unc_and_device_namespace_roots() {
    // A UNC root would make doctor read over SMB; a device-namespace root could
    // block on a named pipe. Neither may produce a candidate path.
    for bad in [r"\\server\share", r"\\.\pipe\evil", r"\\?\C:\Users\u"] {
        let io = FakeIo::new().with_env("USERPROFILE", bad);
        assert!(
            paths(&io, WINDOWS).is_empty(),
            "unsafe Windows root accepted: {bad:?}"
        );
    }
}

#[test]
fn unix_and_windows_branches_are_selected_by_the_flag_not_the_host() {
    // The same env map yields different candidates purely from `HostPlatform`, so
    // the platform facts really do arrive as a parameter.
    let io = FakeIo::new()
        .with_env("HOME", "/home/u")
        .with_env("APPDATA", "/appdata");
    assert!(paths(&io, UNIX)
        .iter()
        .any(|p| p.contains("/home/u/.config/nushell")));
    assert!(!paths(&io, WINDOWS)
        .iter()
        .any(|p| p.contains("/home/u/.config/nushell")));
}

// --- candidate_profiles: the macOS nushell location ---

const MACOS_NU_PATH: &str = "/home/u/Library/Application Support/nushell/config.nu";

#[test]
fn macos_probes_application_support_when_xdg_is_unset() {
    // With no XDG_CONFIG_HOME, nu on macOS reads the Apple convention path — so
    // that, and not `~/.config`, is where the live config sits.
    let io = FakeIo::new().with_env("HOME", "/home/u");
    let found = paths(&io, MACOS);
    assert!(found.contains(&MACOS_NU_PATH.to_string()), "got: {found:?}");
}

#[test]
fn non_macos_unix_does_not_probe_application_support() {
    let io = FakeIo::new().with_env("HOME", "/home/u");
    assert!(!paths(&io, UNIX).contains(&MACOS_NU_PATH.to_string()));
}

#[test]
fn macos_skips_application_support_once_xdg_is_set() {
    // nu prefers XDG_CONFIG_HOME when it is set, so an old file left behind in
    // Application Support is one nu never loads. Reporting it would exit 1 over a
    // file that has no effect on the user's shell.
    let io = FakeIo::new()
        .with_env("HOME", "/home/u")
        .with_env("XDG_CONFIG_HOME", "/xdg");
    let found = paths(&io, MACOS);
    assert!(
        !found.contains(&MACOS_NU_PATH.to_string()),
        "got: {found:?}"
    );
    assert!(
        found.contains(&"/xdg/nushell/config.nu".to_string()),
        "got: {found:?}"
    );
}

#[test]
fn a_stale_application_support_leftover_is_ignored_when_xdg_is_current() {
    // The exit-code consequence of the rule above: the wrapper nu actually loads
    // is current, so the run is clean despite the stale file on disk.
    let io = FakeIo::new()
        .with_env("HOME", "/home/u")
        .with_env("XDG_CONFIG_HOME", "/xdg");
    let fs = FakeProfileFs::new()
        .with_content(MACOS_NU_PATH, OLD_NU_WRAPPER)
        .with_content("/xdg/nushell/config.nu", shell_function(ShellName::Nushell));
    let outcome = doctor_command(&io, &fs, MACOS, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    let text = io.stderr_text();
    assert!(!text.contains("stale"), "got: {text}");
}

#[test]
fn a_stale_wrapper_in_application_support_exits_one_on_macos() {
    let io = unix_io();
    let fs = FakeProfileFs::new().with_content(MACOS_NU_PATH, OLD_NU_WRAPPER);
    let err = doctor_command(&io, &fs, MACOS, OutputOptions::default()).unwrap_err();
    assert_eq!(err.exit_code(), 1);
    let text = io.stderr_text();
    assert!(
        text.contains(&format!("{MACOS_NU_PATH}: stale")),
        "got: {text}"
    );
}

#[test]
fn a_shipped_wrapper_in_application_support_is_clean_on_macos() {
    let io = unix_io();
    let fs = FakeProfileFs::new().with_content(MACOS_NU_PATH, shell_function(ShellName::Nushell));
    doctor_command(&io, &fs, MACOS, OutputOptions::default()).unwrap();
    assert!(io
        .stderr_text()
        .contains(&format!("{MACOS_NU_PATH}: current")));
}

// --- candidate_profiles: invalid roots are named, never echoed ---

#[test]
fn a_set_but_invalid_root_is_recorded_by_name() {
    let io = FakeIo::new()
        .with_env("XDG_CONFIG_HOME", "../evil")
        .with_env("HOME", "/home/u");
    assert_eq!(skipped(&io, UNIX), vec!["XDG_CONFIG_HOME"]);
}

#[test]
fn an_unset_root_is_not_recorded_as_skipped() {
    // An absent XDG_CONFIG_HOME is the normal state; calling it "skipped" would
    // make a healthy setup read as broken.
    let io = FakeIo::new().with_env("HOME", "/home/u");
    assert!(skipped(&io, UNIX).is_empty());
}

#[test]
fn an_invalid_root_produces_a_skip_row_and_a_normal_report() {
    let io = FakeIo::new()
        .with_env("XDG_CONFIG_HOME", "relative/dir")
        .with_env("HOME", "/home/u");
    let fs = FakeProfileFs::new();
    let outcome = doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    let text = io.stderr_text();
    assert!(
        text.contains("XDG_CONFIG_HOME: skipped (invalid value)"),
        "got: {text}"
    );
    // The variable's VALUE is attacker-influenceable and must never be printed.
    assert!(!text.contains("relative/dir"), "got: {text}");
}

#[cfg(windows)]
#[test]
fn windows_continues_past_an_invalid_appdata() {
    let io = FakeIo::new()
        .with_env("APPDATA", r"\\server\share")
        .with_env("USERPROFILE", r"C:\Users\u");
    let fs = FakeProfileFs::new();
    doctor_command(&io, &fs, WINDOWS, OutputOptions::default()).unwrap();
    let text = io.stderr_text();
    assert!(
        text.contains("APPDATA: skipped (invalid value)"),
        "got: {text}"
    );
    assert!(!text.contains("server"), "got: {text}");
}

#[test]
fn no_usable_root_at_all_is_a_configuration_error() {
    // Nothing was inspected, so an empty "all clean" report would be a lie. No
    // report is printed either, so `Configuration` (whose `Error:` line the binary
    // DOES print) rather than `AlreadyReported`.
    let io = FakeIo::new();
    let fs = FakeProfileFs::new();
    let err = doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap_err();
    assert_eq!(err.exit_code(), 1);
    assert!(matches!(err, VibeError::Configuration(_)));
    assert!(!io.stderr_text().contains("Checking shell wrappers"));
}

#[test]
fn an_invalid_home_errors_without_echoing_its_value() {
    for bad in ["", "relative/home", "/home/../etc"] {
        let io = FakeIo::new().with_env("HOME", bad);
        let fs = FakeProfileFs::new();
        let err = doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap_err();
        assert_eq!(err.exit_code(), 1, "HOME={bad:?}");
        assert!(matches!(err, VibeError::Configuration(_)), "HOME={bad:?}");
        // The message names HOME; it must not quote what HOME was set to.
        let message = err.to_string();
        assert!(message.contains("HOME"), "got: {message}");
        let is_echoed = !bad.is_empty() && message.contains(bad);
        assert!(!is_echoed, "HOME value echoed: {message}");
    }
}

#[cfg(windows)]
#[test]
fn the_windows_no_root_message_names_the_windows_variables() {
    let io = FakeIo::new();
    let fs = FakeProfileFs::new();
    let err = doctor_command(&io, &fs, WINDOWS, OutputOptions::default()).unwrap_err();
    let message = err.to_string();
    assert!(message.contains("APPDATA"), "got: {message}");
    assert!(message.contains("USERPROFILE"), "got: {message}");
    assert!(message.contains("OneDrive"), "got: {message}");
}

// --- classify ---

#[test]
fn old_nu_wrapper_is_stale() {
    assert_eq!(
        classify(OLD_NU_WRAPPER, ShellName::Nushell),
        WrapperStatus::Stale
    );
}

#[test]
fn old_pwsh_wrapper_is_stale() {
    assert_eq!(
        classify(OLD_PWSH_WRAPPER, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

/// Drift guard: the wrapper this build ships MUST classify as current, or every
/// user who just followed the docs would be told to fix a correct wrapper.
#[test]
fn shipped_nu_wrapper_is_current() {
    assert_eq!(
        classify(shell_function(ShellName::Nushell), ShellName::Nushell),
        WrapperStatus::Current
    );
}

#[test]
fn shipped_pwsh_wrapper_is_current() {
    assert_eq!(
        classify(shell_function(ShellName::Powershell), ShellName::Powershell),
        WrapperStatus::Current
    );
}

// --- definition matching: the name must be a whole token ---

#[test]
fn a_nu_helper_that_merely_calls_vibe_is_not_a_wrapper() {
    // The command name is `wt`, not `vibe`; calling vibe in the body must not
    // make this look like a broken wrapper.
    for content in [
        "def wt [] { ^vibe start }\n",
        "def --env wt [] { ^vibe start }\n",
        "def greet [] { print 'vibe rocks' }\n",
    ] {
        assert_eq!(
            classify(content, ShellName::Nushell),
            WrapperStatus::NoWrapper,
            "misdiagnosed as a wrapper: {content:?}"
        );
    }
}

#[test]
fn a_nu_command_whose_name_only_starts_with_vibe_is_not_a_wrapper() {
    for content in [
        "def vibe-clean [] { ^vibe clean }\n",
        "def --env vibe_up [] { ^vibe start }\n",
    ] {
        assert_eq!(
            classify(content, ShellName::Nushell),
            WrapperStatus::NoWrapper,
            "misdiagnosed as a wrapper: {content:?}"
        );
    }
}

#[test]
fn a_powershell_function_whose_name_only_starts_with_vibe_is_not_a_wrapper() {
    for content in [
        "function vibe-helper { & vibe.exe status }\n",
        "function vibeUp { & vibe.exe start }\n",
    ] {
        assert_eq!(
            classify(content, ShellName::Powershell),
            WrapperStatus::NoWrapper,
            "misdiagnosed as a wrapper: {content:?}"
        );
    }
}

#[test]
fn a_definition_with_no_space_before_its_signature_is_still_matched() {
    // `def vibe[...]` and `function vibe{` are both legal.
    assert_eq!(
        classify(
            "def --env vibe[...args] { ^vibe ...$args }\n",
            ShellName::Nushell
        ),
        WrapperStatus::Stale
    );
    assert_eq!(
        classify(
            "function vibe{ Invoke-Expression (& vibe.exe $args) }\n",
            ShellName::Powershell
        ),
        WrapperStatus::Stale
    );
}

// --- block scanning: brace styles and marker placement ---

#[test]
fn allman_braced_powershell_wrapper_with_the_marker_is_current() {
    // Allman is idiomatic PowerShell: the opening brace is on its own line, so
    // the definition line carries no `{` at all.
    let content = "function vibe\n\
                   {\n\
                   \x20 $out = & vibe.exe --eval-dialect powershell @args\n\
                   \x20 if ($out) { Invoke-Expression ($out -join \"`n\") }\n\
                   }\n";
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Current
    );
}

#[test]
fn allman_braced_powershell_wrapper_without_the_marker_is_stale() {
    let content = "function vibe\n{\n  Invoke-Expression (& vibe.exe $args)\n}\n";
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_marker_in_a_trailing_comment_on_the_definition_line_does_not_rescue_it() {
    let content = format!("{OLD_NU_WRAPPER} # switch to --eval-dialect nu someday\n");
    assert_eq!(classify(&content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn a_marker_after_the_closing_brace_on_the_same_line_does_not_rescue_it() {
    // The marker is outside the block, in a statement that merely follows it.
    let content = "def --env vibe [...args] { ^vibe ...$args } ; print '--eval-dialect nu'\n";
    assert_eq!(classify(content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn a_marker_before_the_opening_brace_does_not_rescue_it() {
    // Text preceding the block's `{` is not part of the block either.
    let content = "function vibe # --eval-dialect powershell\n{\n  & vibe.exe $args\n}\n";
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_brace_inside_a_string_no_longer_unbalances_the_block() {
    // Masking changed this case's MECHANISM: the `{` is inside a literal, so it
    // is blanked and the block closes normally on the real `}`. The verdict is
    // still stale — now because the closed block genuinely has no marker, and the
    // one below it is outside the block.
    let content = "def --env vibe [...args] { if true {\n\
                   print 'unrelated --eval-dialect nu'\n";
    assert_eq!(classify(content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn a_genuinely_unbalanced_brace_does_not_let_the_scan_reach_a_later_marker() {
    // An unmatched `{` in real code (not in a string) still leaves the depth
    // counter open, so the scan must be bounded rather than running on to an
    // unrelated marker further down the file.
    let content = "def --env vibe [...args] { if true {\n\
                   print 'unrelated --eval-dialect nu'\n";
    assert_eq!(classify(content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn an_unbalanced_brace_stops_at_the_next_wrapper_definition() {
    // The first block never closes; it must not absorb the second, current
    // definition's marker.
    let content = format!(
        "def --env vibe [...args] {{ if true {{\n{}\n",
        shell_function(ShellName::Nushell)
    );
    assert_eq!(classify(&content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn an_unclosed_block_is_stale_even_when_it_contains_the_marker() {
    // Without a closing brace the block has no determinable extent, so a marker
    // inside the assumed region cannot be trusted. Reporting stale prints a fix
    // for a possibly-fine wrapper; the alternative would bless a broken one.
    let content =
        "def --env --wrapped vibe [...args] { let out = (^vibe --eval-dialect nu ...$args)\n";
    assert_eq!(classify(content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn a_marker_far_below_an_unclosed_block_leaves_the_wrapper_stale() {
    // The block never closes before EOF, so its extent is unknown and the marker
    // below it cannot be credited to the wrapper.
    let filler = "print 'x'\n".repeat(60);
    let content =
        format!("def --env vibe [...args] {{ if true {{\n{filler}print '--eval-dialect nu'\n");
    assert_eq!(classify(&content, ShellName::Nushell), WrapperStatus::Stale);
}

// --- nu module exports (`export def`) ---

#[test]
fn an_exported_nu_def_is_classified_like_a_plain_one() {
    // A wrapper kept in a nu module must be written `export def`, and it is every
    // bit as live (and as stale) once the module is `use`d.
    let stale = "export def --env vibe [...args] { ^vibe ...$args | lines | each { |line| nu -c $line } }\n";
    assert_eq!(classify(stale, ShellName::Nushell), WrapperStatus::Stale);

    let current = format!("export {}\n", shell_function(ShellName::Nushell));
    assert_eq!(
        classify(&current, ShellName::Nushell),
        WrapperStatus::Current
    );
}

#[test]
fn other_nu_export_forms_are_not_wrapper_definitions() {
    // Only `export def` defines a command; these must not be misread as wrappers.
    for content in [
        "export alias vibe-x = ^vibe start\n",
        "export-env { $env.VIBE = 1 }\n",
        "export const vibe = 'x'\n",
    ] {
        assert_eq!(
            classify(content, ShellName::Nushell),
            WrapperStatus::NoWrapper,
            "misdiagnosed as a wrapper: {content:?}"
        );
    }
}

// --- block-scan budget: Indeterminate rather than a false `stale` ---

#[test]
fn a_long_but_correct_wrapper_block_is_still_current() {
    // The false-stale guard the old 40-line cap tripped over: a marker-bearing
    // wrapper whose body is merely long must not be reported broken.
    let filler = "  print 'x'\n".repeat(100);
    let content = format!(
        "def --env --wrapped vibe [...args] {{\n\
         \x20   let out = (^vibe --eval-dialect nu ...$args)\n\
         {filler}}}\n"
    );
    assert_eq!(
        classify(&content, ShellName::Nushell),
        WrapperStatus::Current
    );
}

#[test]
fn a_block_that_never_closes_within_the_budget_is_indeterminate() {
    // Past the scan cap there is no evidence either way, so neither `current` nor
    // `stale` can be justified.
    let filler = "print 'x'\n".repeat(1200);
    let content = format!("def --env vibe [...args] {{ if true {{\n{filler}");
    assert_eq!(
        classify(&content, ShellName::Nushell),
        WrapperStatus::Indeterminate
    );
}

#[test]
fn the_scan_cap_boundary_separates_stale_from_indeterminate() {
    // Exactly at the cap the scan saw the whole file and the block simply never
    // closed — that is evidence, so `Stale`. One line further and the scan ran out
    // of budget with the file still going, which is the absence of evidence, so
    // `Indeterminate`. Locking the boundary down because the two verdicts differ
    // in exit code (1 vs 0).
    let unclosed = "def --env vibe [...args] { if true {\n";

    let at_cap = format!(
        "{unclosed}{}",
        "print 'x'\n".repeat(MAX_BLOCK_SEARCH_LINES - 1)
    );
    assert_eq!(
        classify(&at_cap, ShellName::Nushell),
        WrapperStatus::Stale,
        "a block ending exactly at the cap has been fully seen"
    );

    let one_over = format!("{unclosed}{}", "print 'x'\n".repeat(MAX_BLOCK_SEARCH_LINES));
    assert_eq!(
        classify(&one_over, ShellName::Nushell),
        WrapperStatus::Indeterminate,
        "one line past the cap the scan has no verdict to give"
    );
}

#[test]
fn a_stale_wrapper_outranks_an_indeterminate_one_in_the_same_file() {
    let filler = "print 'x'\n".repeat(1200);
    let content = format!("def --env vibe [...args] {{ if true {{\n{filler}{OLD_NU_WRAPPER}\n");
    assert_eq!(classify(&content, ShellName::Nushell), WrapperStatus::Stale);
}

// --- quote-aware comment stripping ---

#[test]
fn a_hash_inside_a_double_quoted_string_does_not_hide_the_marker() {
    // Cutting at the first `#` would truncate the line before the marker and
    // report this correct wrapper as stale.
    let content = "def --env --wrapped vibe [...args] {\n\
                   \x20 let p = \"n#1\"; let out = (^vibe --eval-dialect nu ...$args)\n\
                   }\n";
    assert_eq!(
        classify(content, ShellName::Nushell),
        WrapperStatus::Current
    );
}

#[test]
fn a_hash_inside_a_single_quoted_string_does_not_hide_the_marker() {
    let content = "function vibe {\n\
                   \x20 $h = '#'; $out = & vibe.exe --eval-dialect powershell @args\n\
                   }\n";
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Current
    );
}

#[test]
fn a_genuine_trailing_comment_still_hides_its_marker() {
    // The other direction: quote tracking must not stop `#` from starting a real
    // comment, or a note about the new flag would bless the old wrapper.
    let content = "def --env vibe [...args] { ^vibe ...$args } # --eval-dialect nu\n";
    assert_eq!(classify(content, ShellName::Nushell), WrapperStatus::Stale);

    let inside = "def --env vibe [...args] { ^vibe ...$args # --eval-dialect nu\n}\n";
    assert_eq!(classify(inside, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn a_marker_in_a_comment_after_a_closed_quote_does_not_rescue_it() {
    // The quote opens and closes on the same line, so the following `#` really is
    // a comment.
    let content = "def --env vibe [...args] { print \"a#b\" } # --eval-dialect nu\n";
    assert_eq!(classify(content, ShellName::Nushell), WrapperStatus::Stale);
}

// --- string / block-comment masking (external-review reproductions) ---
//
// Every case here was a FALSE CURRENT before the masking pass: the classifier
// blessed a demonstrably broken wrapper, which is the one direction this command
// must never fail in.

#[test]
fn a_marker_inside_a_double_quoted_string_does_not_bless_a_stale_wrapper() {
    // Reproduction 1a: the flag is merely being TALKED ABOUT in a message.
    let content = "function vibe {\n\
                   \x20 Write-Host \"use --eval-dialect powershell\"\n\
                   \x20 Invoke-Expression (& vibe.exe $args)\n\
                   }\n";
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_marker_inside_a_powershell_block_comment_does_not_bless_a_stale_wrapper() {
    // Reproduction 1b: `<# ... #>` is a comment, on one line and across several.
    let single_line = "function vibe {\n\
                       \x20 Invoke-Expression (& vibe.exe @args) <# TODO --eval-dialect powershell #>\n\
                       }\n";
    assert_eq!(
        classify(single_line, ShellName::Powershell),
        WrapperStatus::Stale
    );

    let multi_line = "function vibe {\n\
                      \x20 Invoke-Expression (& vibe.exe @args)\n\
                      \x20 <# TODO:\n\
                      \x20    switch to --eval-dialect powershell\n\
                      \x20 #>\n\
                      }\n";
    assert_eq!(
        classify(multi_line, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_backtick_escaped_quote_does_not_leak_a_trailing_comment_marker() {
    // Reproduction 2: `` `" `` stays INSIDE the string, so the `#` after it really
    // does start a comment. Treating the escaped quote as closing would end the
    // string early and expose the comment's marker as code.
    let content = "function vibe {\n\
                   \x20 Write-Host \"quote: `\"\" # TODO --eval-dialect powershell\n\
                   \x20 Invoke-Expression (& vibe.exe $args)\n\
                   }\n";
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_closing_brace_inside_a_string_does_not_close_the_block() {
    // Reproduction 3: the only `}` before EOF is inside a literal, so the block
    // never really closes and its marker cannot be trusted.
    let content = "function vibe {\n\
                   \x20 $out = & vibe.exe --eval-dialect powershell @args\n\
                   \x20 Write-Host \"}\"\n";
    assert_ne!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Current,
        "an unclosed block must not read as current"
    );
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_doubled_single_quote_does_not_end_a_powershell_literal() {
    // `''` embeds one literal quote, so the string continues and the marker inside
    // it stays masked.
    let content = "function vibe {\n\
                   \x20 Write-Host 'it''s --eval-dialect powershell'\n\
                   \x20 Invoke-Expression (& vibe.exe $args)\n\
                   }\n";
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_backslash_escaped_quote_keeps_a_nu_string_open() {
    let content = "def --env vibe [...args] {\n\
                   \x20 print \"quote: \\\"\" # TODO --eval-dialect nu\n\
                   \x20 ^vibe ...$args\n\
                   }\n";
    assert_eq!(classify(content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn a_flag_and_its_value_may_sit_on_separate_lines() {
    // Reproduction 6, and the reason the marker search runs over the WHOLE
    // accumulated block rather than per line: splitting a nu pipeline across lines
    // inside parens is valid syntax, and this wrapper genuinely works.
    let content = "def --env --wrapped vibe [...args] {\n\
                   \x20 let out = (\n\
                   \x20   ^vibe\n\
                   \x20   --eval-dialect\n\
                   \x20   nu\n\
                   \x20   ...$args\n\
                   \x20 )\n\
                   \x20 for line in ($out | lines) { print $line }\n\
                   }\n";
    assert_eq!(
        classify(content, ShellName::Nushell),
        WrapperStatus::Current
    );
}

// --- multi-line strings (masking state crosses lines) ---

#[test]
fn a_marker_inside_a_powershell_here_string_does_not_bless_a_stale_wrapper() {
    // The state must survive the newline: a here-string's contents are data, and
    // a marker mentioned there says nothing about how the wrapper calls vibe.
    let content = "function vibe {\n\
                   \x20 $note = @\"\n\
                   \x20 --eval-dialect powershell\n\
                   \x20 \"@\n\
                   \x20 Invoke-Expression (& vibe.exe $args)\n\
                   }\n";
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_marker_inside_a_single_quoted_here_string_does_not_bless_a_stale_wrapper() {
    let content = "function vibe {\n\
                   \x20 $note = @'\n\
                   \x20 --eval-dialect powershell\n\
                   \x20 '@\n\
                   \x20 Invoke-Expression (& vibe.exe $args)\n\
                   }\n";
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_marker_inside_a_nu_raw_string_does_not_bless_a_stale_wrapper() {
    let content = "def --env vibe [...args] {\n\
                   \x20 let note = r#'\n\
                   \x20 --eval-dialect nu\n\
                   \x20 '#\n\
                   \x20 ^vibe ...$args\n\
                   }\n";
    assert_eq!(classify(content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn a_hash_counted_nu_raw_string_needs_a_matching_terminator() {
    // `r##'` is closed only by `'##`, so the `'#` in between stays inside the
    // literal and the marker after it remains masked.
    let content = "def --env vibe [...args] {\n\
                   \x20 let note = r##'\n\
                   \x20 '# --eval-dialect nu\n\
                   \x20 '##\n\
                   \x20 ^vibe ...$args\n\
                   }\n";
    assert_eq!(classify(content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn a_here_string_that_never_mentions_the_marker_leaves_a_good_wrapper_current() {
    // False-positive guard: masking must not swallow the real call below it.
    let content = "function vibe {\n\
                   \x20 $banner = @\"\n\
                   \x20 welcome to the shell\n\
                   \x20 \"@\n\
                   \x20 $out = & vibe.exe --eval-dialect powershell @args\n\
                   \x20 if ($out) { Invoke-Expression ($out -join \"`n\") }\n\
                   }\n";
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Current
    );
}

#[test]
fn a_marker_after_a_properly_closed_here_string_still_counts() {
    // The here-string terminator returns the scan to code, so the genuine flag on
    // the SAME line as the terminator is not lost.
    let content = "function vibe {\n\
                   \x20 $n = @'\n\
                   \x20 note\n\
                   '@; $out = & vibe.exe --eval-dialect powershell @args\n\
                   }\n";
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Current
    );
}

#[test]
fn a_nu_raw_string_that_closes_leaves_a_later_marker_visible() {
    let content = "def --env --wrapped vibe [...args] {\n\
                   \x20 let note = r#'plain'#\n\
                   \x20 let out = (^vibe --eval-dialect nu ...$args)\n\
                   }\n";
    assert_eq!(
        classify(content, ShellName::Nushell),
        WrapperStatus::Current
    );
}

#[test]
fn an_at_sign_splat_is_not_mistaken_for_a_here_string_opener() {
    // `@args` is PowerShell splatting and the shipped wrapper's own syntax; only
    // `@"`/`@'` with nothing after it opens a here-string.
    assert_eq!(
        classify(shell_function(ShellName::Powershell), ShellName::Powershell),
        WrapperStatus::Current
    );
}

#[test]
fn an_unclosed_quote_masks_the_rest_and_never_reads_as_current() {
    // The documented residual failure mode: an unpaired quote swallows the block's
    // remaining braces, so the block cannot close. It must fail toward stale.
    let content = "def --env vibe [...args] {\n\
                   \x20 print 'unterminated\n\
                   \x20 let out = (^vibe --eval-dialect nu ...$args)\n\
                   }\n";
    assert_ne!(
        classify(content, ShellName::Nushell),
        WrapperStatus::Current,
        "an unpaired quote must never produce a current verdict"
    );
}

// --- PowerShell scope qualifiers ---

#[test]
fn a_scope_qualified_stale_wrapper_is_still_a_wrapper() {
    // `function global:vibe` occupies the very same command name, so missing it
    // would report a broken wrapper as "no vibe wrapper" — silently clean.
    for scope in ["global", "script", "local", "private", "GLOBAL"] {
        let content = format!("function {scope}:vibe {{ Invoke-Expression (& vibe.exe $args) }}\n");
        assert_eq!(
            classify(&content, ShellName::Powershell),
            WrapperStatus::Stale,
            "scope qualifier not handled: {scope}"
        );
    }
}

#[test]
fn a_scope_qualified_current_wrapper_is_current() {
    let content = "function global:vibe { $out = & vibe.exe --eval-dialect powershell @args }\n";
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Current
    );
}

#[test]
fn a_name_that_merely_starts_with_a_scope_word_is_not_a_wrapper() {
    // The colon is what makes it a qualifier; `globalvibe` is an unrelated
    // function that must not be rewritten.
    for name in ["globalvibe", "scriptvibe", "global-vibe"] {
        let content = format!("function {name} {{ & vibe.exe start }}\n");
        assert_eq!(
            classify(&content, ShellName::Powershell),
            WrapperStatus::NoWrapper,
            "misdiagnosed as a wrapper: {name}"
        );
    }
}

// --- dialect-value matching ---

#[test]
fn an_aliased_dialect_spelling_is_accepted() {
    // `pwsh` and `nushell` are clap aliases of the same values, so a wrapper
    // using them is functionally the current one.
    let pwsh = "function vibe { $out = & vibe.exe --eval-dialect pwsh @args }\n";
    assert_eq!(
        classify(pwsh, ShellName::Powershell),
        WrapperStatus::Current
    );
    let nu = "def --env --wrapped vibe [...args] { let out = (^vibe --eval-dialect nushell ...$args) }\n";
    assert_eq!(classify(nu, ShellName::Nushell), WrapperStatus::Current);
}

#[test]
fn the_equals_form_of_the_flag_is_accepted() {
    let content =
        "def --env --wrapped vibe [...args] { let out = (^vibe --eval-dialect=nu ...$args) }\n";
    assert_eq!(
        classify(content, ShellName::Nushell),
        WrapperStatus::Current
    );
}

#[test]
fn a_parenthesized_dialect_value_is_accepted() {
    // Parens are shell syntax, not a string literal, so the value survives
    // masking and the punctuation trim still has to cope with it on both sides.
    let content = "function vibe { $out = & vibe.exe --eval-dialect (powershell) @args }\n";
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Current
    );
}

#[test]
fn a_quoted_dialect_value_reads_as_stale_by_design() {
    // A deliberate false-STALE, and the direct price of the masking pass that
    // makes `Write-Host "use --eval-dialect powershell"` read as stale: once a
    // string's CONTENTS are blanked, a quoted value is indistinguishable from a
    // quoted mention. The classifier cannot have both, so it takes the safe
    // direction — printing a fix for a working wrapper, rather than blessing a
    // broken one. `vibe shell-setup` emits the value unquoted, so no wrapper this
    // project ships is affected.
    for value in [
        "\"powershell\"",
        "'powershell'",
        "=\"powershell\"",
        "='powershell'",
    ] {
        let content = format!(
            "function vibe {{ $out = & vibe.exe --eval-dialect{}{value} @args }}\n",
            if value.starts_with('=') { "" } else { " " }
        );
        assert_eq!(
            classify(&content, ShellName::Powershell),
            WrapperStatus::Stale,
            "expected the documented false-stale for: {value:?}"
        );
    }
}

#[test]
fn a_dialect_value_that_merely_starts_with_a_valid_one_is_rejected() {
    // The binary rejects `nub`, so that wrapper IS broken; a substring test would
    // have called it current.
    let content =
        "def --env --wrapped vibe [...args] { let out = (^vibe --eval-dialect nub ...$args) }\n";
    assert_eq!(classify(content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn a_cross_dialect_request_does_not_count() {
    // A nu wrapper asking for the PowerShell dialect gets `Set-Location` lines it
    // cannot run — still broken.
    let content = "def --env --wrapped vibe [...args] { let out = (^vibe --eval-dialect powershell ...$args) }\n";
    assert_eq!(classify(content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn no_wrapper_at_all_is_no_wrapper() {
    assert_eq!(
        classify(
            "$env.PATH = ($env.PATH | append '/opt/bin')\n",
            ShellName::Nushell
        ),
        WrapperStatus::NoWrapper
    );
    assert_eq!(
        classify("Set-Alias ll Get-ChildItem\n", ShellName::Powershell),
        WrapperStatus::NoWrapper
    );
}

#[test]
fn commented_out_definition_is_not_a_wrapper() {
    let nu = format!("# {OLD_NU_WRAPPER}\n");
    assert_eq!(classify(&nu, ShellName::Nushell), WrapperStatus::NoWrapper);
    let pwsh = format!("  # {OLD_PWSH_WRAPPER}\n");
    assert_eq!(
        classify(&pwsh, ShellName::Powershell),
        WrapperStatus::NoWrapper
    );
}

#[test]
fn marker_in_a_comment_outside_the_block_does_not_rescue_a_stale_wrapper() {
    // The likeliest false-negative: a user leaves a note about the new flag
    // above (or below) the old definition they never actually replaced.
    let content =
        format!("# TODO: switch to --eval-dialect nu\n{OLD_NU_WRAPPER}\n# see --eval-dialect nu\n");
    assert_eq!(classify(&content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn marker_in_a_comment_inside_the_block_does_not_rescue_a_stale_wrapper() {
    let content = "def --env vibe [...args] {\n  # --eval-dialect nu\n  ^vibe ...$args\n}\n";
    assert_eq!(classify(content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn reformatted_multiline_wrapper_with_the_marker_is_current() {
    // The docs show the nu wrapper split across lines; that form must pass.
    let content = "def --env --wrapped vibe [...args] {\n\
                   \x20   let out = (^vibe --eval-dialect nu ...$args)\n\
                   \x20   for line in ($out | lines) { print $line }\n\
                   }\n";
    assert_eq!(
        classify(content, ShellName::Nushell),
        WrapperStatus::Current
    );
}

#[test]
fn stale_wins_when_a_file_defines_several_wrappers() {
    let current = shell_function(ShellName::Nushell);
    let content = format!("{current}\n{OLD_NU_WRAPPER}\n");
    assert_eq!(classify(&content, ShellName::Nushell), WrapperStatus::Stale);
    // Order must not matter.
    let reversed = format!("{OLD_NU_WRAPPER}\n{current}\n");
    assert_eq!(
        classify(&reversed, ShellName::Nushell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_marker_belonging_to_a_later_block_does_not_leak_backwards() {
    // Two adjacent definitions: the first is stale, the second current. Brace
    // scoping must stop the first block's scan before the second's marker.
    let content = format!(
        "def --env vibe [...args] {{ ^vibe ...$args }}\n{}\n",
        shell_function(ShellName::Nushell)
    );
    assert_eq!(classify(&content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn powershell_definition_is_matched_case_insensitively() {
    let content = "Function Vibe { Invoke-Expression (& vibe.exe $args) }\n";
    assert_eq!(
        classify(content, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_nu_def_that_is_not_vibe_is_ignored() {
    let content = "def --env cdp [] { cd /tmp }\n";
    assert_eq!(
        classify(content, ShellName::Nushell),
        WrapperStatus::NoWrapper
    );
}

// --- doctor_command ---

fn unix_io() -> FakeIo {
    FakeIo::new().with_env("HOME", "/home/u")
}

const NU_PATH: &str = "/home/u/.config/nushell/config.nu";
const PWSH_PATH: &str = "/home/u/.config/powershell/Microsoft.PowerShell_profile.ps1";

#[test]
fn stale_wrapper_exits_one_and_prints_the_fix() {
    let io = unix_io();
    let fs = FakeProfileFs::new().with_content(NU_PATH, OLD_NU_WRAPPER);
    let err = doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap_err();
    assert_eq!(err.exit_code(), 1);
    // AlreadyReported so the binary adds no second, contentless error line.
    assert!(matches!(err, VibeError::AlreadyReported));

    let text = io.stderr_text();
    assert!(text.contains(&format!("{NU_PATH}: stale")), "got: {text}");
    assert!(
        text.contains("vibe shell-setup --shell nushell"),
        "got: {text}"
    );
}

#[test]
fn current_wrapper_is_clean_and_produces_no_stdout() {
    let io = unix_io();
    let fs = FakeProfileFs::new().with_content(NU_PATH, shell_function(ShellName::Nushell));
    let outcome = doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    let text = io.stderr_text();
    assert!(text.contains(&format!("{NU_PATH}: current")), "got: {text}");
    assert!(!text.contains("Fix:"), "got: {text}");
}

#[test]
fn no_profiles_at_all_is_clean() {
    let io = unix_io();
    let fs = FakeProfileFs::new();
    let outcome = doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    assert!(io
        .stderr_text()
        .contains("No nushell or PowerShell profile found."));
}

#[test]
fn a_profile_without_a_wrapper_is_clean_but_still_reported() {
    let io = unix_io();
    let fs = FakeProfileFs::new().with_content(NU_PATH, "$env.EDITOR = 'hx'\n");
    doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap();
    assert!(io
        .stderr_text()
        .contains(&format!("{NU_PATH}: no vibe wrapper")));
}

#[test]
fn unreadable_and_non_regular_files_are_reported_without_failing() {
    let io = unix_io();
    let fs = FakeProfileFs::new()
        .with_read(NU_PATH, ProfileRead::Rejected)
        .with_read(PWSH_PATH, ProfileRead::Unreadable);
    let outcome = doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    let text = io.stderr_text();
    assert!(
        text.contains(&format!("{NU_PATH}: not checked (not a regular file)")),
        "got: {text}"
    );
    assert!(
        text.contains(&format!("{PWSH_PATH}: unreadable")),
        "got: {text}"
    );
}

#[test]
fn two_stale_profiles_each_get_their_own_row_and_fix_line() {
    let io = unix_io();
    let fs = FakeProfileFs::new()
        .with_content(NU_PATH, OLD_NU_WRAPPER)
        .with_content(PWSH_PATH, OLD_PWSH_WRAPPER);
    let err = doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap_err();
    assert_eq!(err.exit_code(), 1);

    let text = io.stderr_text();
    assert!(text.contains(&format!("{NU_PATH}: stale")), "got: {text}");
    assert!(text.contains(&format!("{PWSH_PATH}: stale")), "got: {text}");
    // Each Fix line must name the shell belonging to ITS path, not the other's.
    assert!(
        text.contains(&format!(
            "Fix: run 'vibe shell-setup --shell nushell' and replace the vibe function in {NU_PATH}"
        )),
        "got: {text}"
    );
    assert!(
        text.contains(&format!(
            "Fix: run 'vibe shell-setup --shell powershell' and replace the vibe function in {PWSH_PATH}"
        )),
        "got: {text}"
    );
}

/// `RealProfileFs` must distinguish "no such file" from "could not look".
/// Reporting an EACCES as `Missing` would hide the file the user asked about.
#[cfg(unix)]
#[test]
fn a_metadata_error_that_is_not_not_found_reads_as_unreadable() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = tempfile::tempdir().unwrap();
    let locked = tmp.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    let profile = locked.join("config.nu");
    std::fs::write(&profile, "def --env vibe [] {}\n").unwrap();
    // Drop search permission on the parent: `metadata` now fails with EACCES.
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

    let read = RealProfileFs.read_profile(&profile);

    // Restore before asserting so the tempdir can always clean itself up.
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(read, ProfileRead::Unreadable);
}

#[test]
fn a_genuinely_absent_profile_reads_as_missing() {
    let tmp = tempfile::tempdir().unwrap();
    let read = RealProfileFs.read_profile(&tmp.path().join("nope.nu"));
    assert_eq!(read, ProfileRead::Missing);
}

#[test]
fn a_directory_in_a_profile_slot_reads_as_rejected() {
    // The type gate that keeps a FIFO/device from blocking the read.
    let tmp = tempfile::tempdir().unwrap();
    let read = RealProfileFs.read_profile(tmp.path());
    assert_eq!(read, ProfileRead::Rejected);
}

#[test]
fn an_indeterminate_wrapper_is_reported_without_failing_the_run() {
    // No verdict was reachable, so failing would punish a file that may be fine;
    // the row plus the closing shell-setup hint is the remedy.
    let io = unix_io();
    let filler = "print 'x'\n".repeat(1200);
    let content = format!("def --env vibe [...args] {{ if true {{\n{filler}");
    let fs = FakeProfileFs::new().with_content(NU_PATH, &content);
    let outcome = doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    let text = io.stderr_text();
    assert!(
        text.contains(&format!(
            "{NU_PATH}: could not determine (wrapper block too long)"
        )),
        "got: {text}"
    );
    assert!(!text.contains("stale"), "got: {text}");
}

#[test]
fn a_stale_wrapper_elsewhere_still_fails_the_run_alongside_an_indeterminate_one() {
    let io = unix_io();
    let filler = "print 'x'\n".repeat(1200);
    let indeterminate = format!("def --env vibe [...args] {{ if true {{\n{filler}");
    let fs = FakeProfileFs::new()
        .with_content(NU_PATH, &indeterminate)
        .with_content(PWSH_PATH, OLD_PWSH_WRAPPER);
    let err = doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap_err();
    assert_eq!(err.exit_code(), 1);
    let text = io.stderr_text();
    assert!(text.contains("could not determine"), "got: {text}");
    assert!(text.contains(&format!("{PWSH_PATH}: stale")), "got: {text}");
}

// --- profile decoding ---

/// UTF-16 bytes for `text`, with the matching BOM.
fn utf16_bytes(text: &str, little_endian: bool) -> Vec<u8> {
    let bom: u16 = 0xFEFF;
    std::iter::once(bom)
        .chain(text.encode_utf16())
        .flat_map(|unit| {
            if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            }
        })
        .collect()
}

#[test]
fn a_utf8_bom_does_not_hide_a_stale_wrapper() {
    // Windows editors add this BOM on save; decoded as-is the first line would
    // start with U+FEFF and never match `function vibe`.
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(OLD_PWSH_WRAPPER.as_bytes());
    let decoded = decode_profile_bytes(&bytes);
    assert_eq!(decoded, OLD_PWSH_WRAPPER);
    assert_eq!(
        classify(&decoded, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_utf16le_profile_is_decoded_and_classified() {
    // `Out-File` defaulted to UTF-16LE through Windows PowerShell 5.1, so this is
    // exactly how a stale wrapper may be stored.
    let decoded = decode_profile_bytes(&utf16_bytes(OLD_PWSH_WRAPPER, true));
    assert_eq!(decoded, OLD_PWSH_WRAPPER);
    assert_eq!(
        classify(&decoded, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_utf16be_profile_is_decoded_and_classified() {
    let decoded = decode_profile_bytes(&utf16_bytes(OLD_PWSH_WRAPPER, false));
    assert_eq!(decoded, OLD_PWSH_WRAPPER);
    assert_eq!(
        classify(&decoded, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_utf16le_shipped_wrapper_is_still_current() {
    // The other direction: encoding must not turn a correct wrapper into a
    // "fix this" report either.
    let shipped = shell_function(ShellName::Powershell);
    let decoded = decode_profile_bytes(&utf16_bytes(shipped, true));
    assert_eq!(decoded, shipped);
    assert_eq!(
        classify(&decoded, ShellName::Powershell),
        WrapperStatus::Current
    );
}

#[test]
fn plain_utf8_without_a_bom_is_unchanged() {
    assert_eq!(
        decode_profile_bytes(OLD_NU_WRAPPER.as_bytes()),
        OLD_NU_WRAPPER
    );
}

#[test]
fn a_real_utf16le_profile_file_reads_as_stale() {
    let tmp = tempfile::tempdir().unwrap();
    let profile = tmp.path().join("profile.ps1");
    std::fs::write(&profile, utf16_bytes(OLD_PWSH_WRAPPER, true)).unwrap();
    let ProfileRead::Present { content, .. } = RealProfileFs.read_profile(&profile) else {
        panic!("expected a readable profile");
    };
    assert_eq!(
        classify(&content, ShellName::Powershell),
        WrapperStatus::Stale
    );
}

#[test]
fn a_real_profile_file_is_read_and_classified() {
    let tmp = tempfile::tempdir().unwrap();
    let profile = tmp.path().join("config.nu");
    std::fs::write(&profile, OLD_NU_WRAPPER).unwrap();
    let read = RealProfileFs.read_profile(&profile);
    assert_eq!(
        read,
        ProfileRead::Present {
            content: OLD_NU_WRAPPER.to_string(),
            truncated: false,
        }
    );
}

#[test]
fn an_oversized_profile_is_classified_and_flagged() {
    let io = unix_io();
    let fs = FakeProfileFs::new().with_truncated(NU_PATH, OLD_NU_WRAPPER);
    let err = doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap_err();
    assert_eq!(err.exit_code(), 1);
    let text = io.stderr_text();
    assert!(text.contains(&format!("{NU_PATH}: stale")), "got: {text}");
    assert!(
        text.contains("file too large; checked first 1 MB"),
        "got: {text}"
    );
}

#[test]
fn quiet_still_prints_the_report_and_keeps_the_exit_code() {
    // `vibe doctor -q` exiting 1 in silence would be unexplainable, so the
    // report must survive --quiet.
    let io = unix_io();
    let fs = FakeProfileFs::new().with_content(NU_PATH, OLD_NU_WRAPPER);
    let err = doctor_command(&io, &fs, UNIX, OutputOptions::new(false, true)).unwrap_err();
    assert_eq!(err.exit_code(), 1);
    let text = io.stderr_text();
    assert!(text.contains(&format!("{NU_PATH}: stale")), "got: {text}");
    assert!(text.contains("Fix: run"), "got: {text}");
}

#[test]
fn verbose_names_every_path_it_looked_at_including_absent_ones() {
    // An absent profile is not a finding, so it never reaches the report — but
    // "doctor said nothing about my file" is the confusing case, so --verbose
    // must still name it.
    let io = unix_io();
    let fs = FakeProfileFs::new();
    doctor_command(&io, &fs, UNIX, OutputOptions::new(true, false)).unwrap();
    let text = io.stderr_text();
    assert!(
        text.contains(&format!("[verbose] checking {NU_PATH}")),
        "got: {text}"
    );
    assert!(
        text.contains(&format!("[verbose] checking {PWSH_PATH}")),
        "got: {text}"
    );
}

#[test]
fn only_the_stale_line_is_colored() {
    // A passing check painted yellow reads as a problem, so the warning color is
    // reserved for the finding itself.
    let io = FakeIo::new()
        .with_env("HOME", "/home/u")
        .with_env("FORCE_COLOR", "1");
    let fs = FakeProfileFs::new()
        .with_content(NU_PATH, OLD_NU_WRAPPER)
        .with_content(PWSH_PATH, shell_function(ShellName::Powershell));
    doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap_err();

    let colored: Vec<String> = io
        .stderr
        .borrow()
        .iter()
        .filter(|line| line.contains("\x1b[33m"))
        .cloned()
        .collect();
    // Only the stale row and its Fix line carry the warning color; the header,
    // the `current` row and the closing hint stay uncolored.
    assert!(
        colored
            .iter()
            .all(|line| line.contains("stale") || line.contains("Fix: run")),
        "non-finding lines were colored: {colored:?}"
    );
    assert_eq!(colored.len(), 2, "expected exactly the finding pair");
}

#[test]
fn control_characters_in_a_reported_path_are_sanitized() {
    // The path comes from the environment, so a hostile HOME must not be able to
    // emit raw escape sequences into the operator's terminal.
    let io = FakeIo::new().with_env("HOME", "/home/u\x1b[2Kfake");
    let fs = FakeProfileFs::new();
    doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap();
    assert!(!io.stderr_text().contains('\x1b'));
}

#[test]
fn a_stale_powershell_wrapper_names_the_powershell_shell_in_the_fix() {
    let io = unix_io();
    let fs = FakeProfileFs::new().with_content(PWSH_PATH, OLD_PWSH_WRAPPER);
    doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap_err();
    assert!(io
        .stderr_text()
        .contains("vibe shell-setup --shell powershell"));
}

#[test]
fn the_closing_hint_always_mentions_shell_setup() {
    let io = unix_io();
    let fs = FakeProfileFs::new();
    doctor_command(&io, &fs, UNIX, OutputOptions::default()).unwrap();
    assert!(io.stderr_text().contains("vibe shell-setup --shell"));
}

// --- is_safe_root ---

#[test]
fn safe_root_accepts_a_plain_absolute_unix_path() {
    #[cfg(not(windows))]
    assert!(is_safe_root("/home/u"));
    #[cfg(windows)]
    assert!(is_safe_root(r"C:\Users\u"));
}
