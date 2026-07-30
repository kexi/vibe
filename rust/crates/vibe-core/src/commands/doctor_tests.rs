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

fn paths(io: &FakeIo, is_windows: bool) -> Vec<String> {
    candidate_profiles(io, is_windows)
        .into_iter()
        .map(|(_, p)| p.to_string_lossy().replace('\\', "/"))
        .collect()
}

// --- candidate_profiles: env matrix ---

#[test]
fn unix_defaults_to_home_dot_config() {
    let io = FakeIo::new().with_env("HOME", "/home/u");
    assert_eq!(
        paths(&io, false),
        vec![
            "/home/u/.config/nushell/config.nu",
            "/home/u/.config/powershell/Microsoft.PowerShell_profile.ps1",
            "/home/u/.config/powershell/profile.ps1",
        ]
    );
}

#[test]
fn unix_prefers_xdg_config_home_over_home() {
    let io = FakeIo::new()
        .with_env("HOME", "/home/u")
        .with_env("XDG_CONFIG_HOME", "/xdg");
    assert_eq!(
        paths(&io, false),
        vec![
            "/xdg/nushell/config.nu",
            "/xdg/powershell/Microsoft.PowerShell_profile.ps1",
            "/xdg/powershell/profile.ps1",
        ]
    );
}

#[test]
fn unix_with_no_home_at_all_has_no_candidates() {
    let io = FakeIo::new();
    assert!(paths(&io, false).is_empty());
}

#[test]
fn unsafe_env_roots_are_rejected() {
    // Relative, `..`-bearing and empty roots are all refused, and with no safe
    // fallback the candidate list is empty (never a path built from them).
    for bad in ["relative/config", "/home/../etc", ""] {
        let io = FakeIo::new().with_env("XDG_CONFIG_HOME", bad);
        assert!(
            paths(&io, false).is_empty(),
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
        paths(&io, false),
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
    assert!(paths(&io, false)
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
        paths(&io, true),
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
    let found = paths(&io, true);
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
            paths(&io, true).is_empty(),
            "unsafe Windows root accepted: {bad:?}"
        );
    }
}

#[test]
fn unix_and_windows_branches_are_selected_by_the_flag_not_the_host() {
    // The same env map yields different candidates purely from `is_windows`, so
    // the platform fact really does arrive as a parameter.
    let io = FakeIo::new()
        .with_env("HOME", "/home/u")
        .with_env("APPDATA", "/appdata");
    assert!(paths(&io, false)
        .iter()
        .any(|p| p.contains("/home/u/.config/nushell")));
    assert!(!paths(&io, true)
        .iter()
        .any(|p| p.contains("/home/u/.config/nushell")));
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
fn an_unbalanced_brace_does_not_let_the_scan_reach_a_later_marker() {
    // A `{` inside a string literal leaves the depth counter unbalanced. This
    // classifier deliberately does not parse string literals, so the scan must be
    // bounded instead of running on to an unrelated marker further down the file.
    let content = "def --env vibe [...args] { print \"{\" }\n\
                   print 'unrelated --eval-dialect nu'\n";
    assert_eq!(classify(content, ShellName::Nushell), WrapperStatus::Stale);
}

#[test]
fn an_unbalanced_brace_stops_at_the_next_wrapper_definition() {
    // The first (stale) block never closes; it must not absorb the second,
    // current definition's marker.
    let content = format!(
        "def --env vibe [...args] {{ print \"{{\" }}\n{}\n",
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
fn a_marker_far_below_an_unclosed_block_is_out_of_scan_range() {
    let filler = "print 'x'\n".repeat(60);
    let content =
        format!("def --env vibe [...args] {{ print \"{{\" }}\n{filler}print '--eval-dialect nu'\n");
    assert_eq!(classify(&content, ShellName::Nushell), WrapperStatus::Stale);
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
    let err = doctor_command(&io, &fs, false, OutputOptions::default()).unwrap_err();
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
    let outcome = doctor_command(&io, &fs, false, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    let text = io.stderr_text();
    assert!(text.contains(&format!("{NU_PATH}: current")), "got: {text}");
    assert!(!text.contains("Fix:"), "got: {text}");
}

#[test]
fn no_profiles_at_all_is_clean() {
    let io = unix_io();
    let fs = FakeProfileFs::new();
    let outcome = doctor_command(&io, &fs, false, OutputOptions::default()).unwrap();
    assert_eq!(outcome, Outcome::none());
    assert!(io
        .stderr_text()
        .contains("No nushell or PowerShell profile found."));
}

#[test]
fn a_profile_without_a_wrapper_is_clean_but_still_reported() {
    let io = unix_io();
    let fs = FakeProfileFs::new().with_content(NU_PATH, "$env.EDITOR = 'hx'\n");
    doctor_command(&io, &fs, false, OutputOptions::default()).unwrap();
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
    let outcome = doctor_command(&io, &fs, false, OutputOptions::default()).unwrap();
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
    let err = doctor_command(&io, &fs, false, OutputOptions::default()).unwrap_err();
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
    let err = doctor_command(&io, &fs, false, OutputOptions::default()).unwrap_err();
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
    let err = doctor_command(&io, &fs, false, OutputOptions::new(false, true)).unwrap_err();
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
    doctor_command(&io, &fs, false, OutputOptions::new(true, false)).unwrap();
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
    doctor_command(&io, &fs, false, OutputOptions::default()).unwrap_err();

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
    doctor_command(&io, &fs, false, OutputOptions::default()).unwrap();
    assert!(!io.stderr_text().contains('\x1b'));
}

#[test]
fn a_stale_powershell_wrapper_names_the_powershell_shell_in_the_fix() {
    let io = unix_io();
    let fs = FakeProfileFs::new().with_content(PWSH_PATH, OLD_PWSH_WRAPPER);
    doctor_command(&io, &fs, false, OutputOptions::default()).unwrap_err();
    assert!(io
        .stderr_text()
        .contains("vibe shell-setup --shell powershell"));
}

#[test]
fn the_closing_hint_always_mentions_shell_setup() {
    let io = unix_io();
    let fs = FakeProfileFs::new();
    doctor_command(&io, &fs, false, OutputOptions::default()).unwrap();
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
