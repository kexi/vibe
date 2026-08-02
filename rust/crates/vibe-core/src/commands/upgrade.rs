//! `vibe upgrade`: check the npm registry for a newer version and show upgrade
//! instructions.
//!
//! Originally ported from `packages/core/src/commands/upgrade.ts`. The latest
//! version comes from the npm registry packument (the active channel after JSR
//! was removed in Phase 6). Network access is the injected [`HttpClient`];
//! version math and install-method detection are the pure helpers in
//! [`crate::upgrade_meta`]. Build/runtime facts (version, distribution, exec
//! path) are passed in via [`UpgradeEnv`] so the command is fully testable
//! offline. No `cd` is produced.

use crate::commands::shell_setup::{detect_shell, ShellName};
use crate::commands::Outcome;
use crate::error::{Result, VibeError};
use crate::http::{HttpClient, MAX_RESPONSE_SIZE};
use crate::io::Io;
use crate::output::{log, verbose_log, warn_log, OutputOptions};
use crate::shell::EvalDialect;
use crate::upgrade_meta::{
    detect_install_method, is_homebrew_path, is_npm_path, latest_version_from_meta, parse_semver,
    upgrade_command,
};
use std::cmp::Ordering;
use std::time::Duration;

const NPM_META_URL: &str = "https://registry.npmjs.org/@kexi/vibe";
const GITHUB_RELEASES_URL: &str = "https://github.com/kexi/vibe/releases";

/// Build/runtime facts the upgrade command needs, supplied by the binary.
pub struct UpgradeEnv<'a> {
    /// The running binary's version (e.g. `1.8.1+abc`).
    pub version: &'a str,
    /// The build distribution channel (`deb`/`binary`/`dev`/...).
    pub distribution: &'a str,
    /// The current executable path (for homebrew detection).
    pub exec_path: &'a str,
    /// The realpath of the executable (symlinks resolved).
    pub real_path: &'a str,
    /// Whether the host is macOS (homebrew detection only applies there).
    pub is_mac: bool,
    /// Whether the host is Windows (widens the stale-wrapper notice audience).
    pub is_windows: bool,
    /// The stdout dialect the calling wrapper requested. A read-only copy: the
    /// binary owns the dialect used for the actual stdout write, and this
    /// command never returns one.
    pub eval_dialect: EvalDialect,
}

/// The one-line pointer at `vibe doctor`, shown when a stale pasted nushell /
/// PowerShell wrapper is plausible.
const STALE_WRAPPER_NOTICE: &str =
    "Note: nushell/PowerShell wrappers pasted before vibe 2.2.0 were broken and \
     have been replaced. Run 'vibe doctor' to check yours.";

/// Whether to show [`STALE_WRAPPER_NOTICE`].
///
/// A wrapper that passes `--eval-dialect nu`/`powershell` is by definition the
/// NEW one, so the notice would be pure noise — the Posix default (which is also
/// what every old wrapper sends, since it passes no flag at all) is the only
/// dialect worth warning under. Beyond that, either `$SHELL` names nushell or
/// PowerShell, or the host is Windows (where `$SHELL` is usually unset yet
/// PowerShell is the default shell).
///
/// `$SHELL` is only inspected, never printed: it is user-controlled and the
/// notice goes to a terminal.
fn should_show_stale_wrapper_notice(io: &impl Io, env: &UpgradeEnv) -> bool {
    let is_posix_dialect = env.eval_dialect == EvalDialect::Posix;
    if !is_posix_dialect {
        return false;
    }
    if env.is_windows {
        return true;
    }
    let shell = io.env("SHELL").unwrap_or_default();
    matches!(
        detect_shell(&shell),
        Some(ShellName::Nushell) | Some(ShellName::Powershell)
    )
}

/// Print the notice when it applies. `warn_log` (not `log`) so it survives
/// `--quiet`: a user scripting `vibe upgrade -q` is exactly the user who would
/// otherwise never learn their wrapper is broken.
fn maybe_warn_stale_wrapper(io: &impl Io, env: &UpgradeEnv) {
    if should_show_stale_wrapper_notice(io, env) {
        warn_log(io, STALE_WRAPPER_NOTICE);
    }
}

/// Run `vibe upgrade`. `check` is the `--check` flag.
pub fn upgrade_command_run(
    io: &impl Io,
    http: &impl HttpClient,
    env: &UpgradeEnv,
    check: bool,
    opts: OutputOptions,
) -> Result<Outcome> {
    let current_version = parse_semver(env.version);

    verbose_log(
        io,
        &format!("Checking for updates from {NPM_META_URL}"),
        opts,
    );
    log(io, &format!("vibe {}", env.version), opts);
    log(io, "", opts);

    // Before the network call, not after: the user most likely to be running a
    // broken wrapper is also the one behind a proxy or offline, and every later
    // placement loses the notice to the `?` on `fetch_latest_version`. The notice
    // is about the LOCAL shell setup, so it is true regardless of what the
    // registry says.
    maybe_warn_stale_wrapper(io, env);

    let latest_version = fetch_latest_version(http)?;

    let comparison = crate::upgrade_meta::compare_versions(&current_version, &latest_version)?;
    let is_up_to_date = comparison != Ordering::Less;
    if is_up_to_date {
        log(io, "You are using the latest version.", opts);
        return Ok(Outcome::none());
    }

    log(
        io,
        &format!("A new version is available: {latest_version}"),
        opts,
    );
    log(io, "", opts);

    if check {
        log(io, &format!("Current: {current_version}"), opts);
        log(io, &format!("Latest:  {latest_version}"), opts);
        return Ok(Outcome::none());
    }

    let is_npm = is_npm_path(env.exec_path, env.real_path);
    let is_homebrew = is_homebrew_path(env.is_mac, env.exec_path, env.real_path);
    let method = detect_install_method(env.distribution, is_npm, is_homebrew);
    verbose_log(io, &format!("Detected install method: {method:?}"), opts);

    let release_tag = format!("{GITHUB_RELEASES_URL}/tag/v{latest_version}");
    match upgrade_command(method) {
        Some(cmd) => {
            log(io, "To upgrade:", opts);
            log(io, &format!("  {cmd}"), opts);
        }
        None => {
            log(io, "Download the latest version:", opts);
            log(io, &format!("  {release_tag}"), opts);
        }
    }

    log(io, "", opts);
    log(io, "Release notes:", opts);
    log(io, &format!("  {release_tag}"), opts);

    Ok(Outcome::none())
}

/// Fetch + validate the npm registry packument and return `dist-tags.latest`.
///
/// Non-2xx (already an `Err` from the client), a Content-Type prefix check on
/// `application/json`, a 1 MB body cap (enforced in the client via `take`,
/// re-checked here defensively), then strict JSON parse of `dist-tags.latest`.
fn fetch_latest_version(http: &impl HttpClient) -> Result<String> {
    let response = http.get(NPM_META_URL, Duration::from_secs(5))?;

    let is_ok = (200..300).contains(&response.status);
    if !is_ok {
        return Err(VibeError::Network(format!(
            "Failed to fetch version information (HTTP {})",
            response.status
        )));
    }

    // Content-Type must START WITH application/json (allow `; charset=...`). The
    // real gate is the strict JSON parse below; this just rejects obvious HTML.
    let is_json = response
        .content_type
        .as_deref()
        .is_some_and(|ct| ct.starts_with("application/json"));
    if !is_json {
        return Err(VibeError::Network(
            "Invalid response format: expected JSON".to_string(),
        ));
    }

    let too_large = response.body.len() as u64 > MAX_RESPONSE_SIZE;
    if too_large {
        return Err(VibeError::Network("Response too large".to_string()));
    }

    latest_version_from_meta(&response.body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::FakeHttpClient;
    use crate::io::FakeIo;

    fn env<'a>(version: &'a str, distribution: &'a str) -> UpgradeEnv<'a> {
        UpgradeEnv {
            version,
            distribution,
            exec_path: "/home/u/.local/bin/vibe",
            real_path: "/home/u/.local/bin/vibe",
            is_mac: false,
            is_windows: false,
            eval_dialect: EvalDialect::Posix,
        }
    }

    fn meta(latest: &str) -> String {
        format!(r#"{{ "dist-tags": {{ "latest": "{latest}" }} }}"#)
    }

    #[test]
    fn reports_up_to_date() {
        let io = FakeIo::new();
        let http = FakeHttpClient::json(&meta("1.0.0"));
        let outcome = upgrade_command_run(
            &io,
            &http,
            &env("1.0.0", "dev"),
            false,
            OutputOptions::default(),
        )
        .unwrap();
        assert_eq!(outcome, Outcome::none());
        assert!(io
            .stderr_text()
            .contains("You are using the latest version."));
    }

    #[test]
    fn reports_new_version_with_dev_upgrade_command() {
        let io = FakeIo::new();
        let http = FakeHttpClient::json(&meta("2.0.0"));
        upgrade_command_run(
            &io,
            &http,
            &env("1.0.0", "dev"),
            false,
            OutputOptions::default(),
        )
        .unwrap();
        let text = io.stderr_text();
        assert!(text.contains("A new version is available: 2.0.0"));
        assert!(text.contains("pnpm run build:rust"));
        assert!(text.contains("releases/tag/v2.0.0"));
    }

    #[test]
    fn check_flag_shows_current_and_latest_only() {
        let io = FakeIo::new();
        let http = FakeHttpClient::json(&meta("2.0.0"));
        upgrade_command_run(
            &io,
            &http,
            &env("1.0.0", "dev"),
            true,
            OutputOptions::default(),
        )
        .unwrap();
        let text = io.stderr_text();
        assert!(text.contains("Current: 1.0.0"));
        assert!(text.contains("Latest:  2.0.0"));
        // --check does not print the upgrade command.
        assert!(!text.contains("To upgrade:"));
    }

    #[test]
    fn binary_distribution_shows_download_link() {
        let io = FakeIo::new();
        let http = FakeHttpClient::json(&meta("2.0.0"));
        upgrade_command_run(
            &io,
            &http,
            &env("1.0.0", "binary"),
            false,
            OutputOptions::default(),
        )
        .unwrap();
        let text = io.stderr_text();
        assert!(text.contains("Download the latest version:"));
        assert!(text.contains("releases/tag/v2.0.0"));
    }

    #[test]
    fn homebrew_detected_for_binary_under_opt_homebrew() {
        let io = FakeIo::new();
        let http = FakeHttpClient::json(&meta("2.0.0"));
        let env = UpgradeEnv {
            version: "1.0.0",
            distribution: "binary",
            exec_path: "/opt/homebrew/bin/vibe",
            real_path: "/opt/homebrew/bin/vibe",
            is_mac: true,
            is_windows: false,
            eval_dialect: EvalDialect::Posix,
        };
        upgrade_command_run(&io, &http, &env, false, OutputOptions::default()).unwrap();
        assert!(io.stderr_text().contains("brew upgrade kexi/tap/vibe"));
    }

    #[test]
    fn non_2xx_status_is_error() {
        let io = FakeIo::new();
        let http = FakeHttpClient::with(500, Some("application/json"), "{}");
        assert!(upgrade_command_run(
            &io,
            &http,
            &env("1.0.0", "dev"),
            false,
            OutputOptions::default()
        )
        .is_err());
    }

    #[test]
    fn non_json_content_type_is_error() {
        let io = FakeIo::new();
        let http = FakeHttpClient::with(200, Some("text/html"), "<html>");
        assert!(upgrade_command_run(
            &io,
            &http,
            &env("1.0.0", "dev"),
            false,
            OutputOptions::default()
        )
        .is_err());
    }

    #[test]
    fn content_type_with_charset_is_accepted() {
        let io = FakeIo::new();
        let http =
            FakeHttpClient::with(200, Some("application/json; charset=utf-8"), &meta("2.0.0"));
        assert!(upgrade_command_run(
            &io,
            &http,
            &env("1.0.0", "dev"),
            false,
            OutputOptions::default()
        )
        .is_ok());
    }

    #[test]
    fn transport_error_propagates() {
        // Simulates the redirect-rejected case: client returns a network error.
        let io = FakeIo::new();
        let http = FakeHttpClient::error("redirect not allowed");
        assert!(upgrade_command_run(
            &io,
            &http,
            &env("1.0.0", "dev"),
            false,
            OutputOptions::default()
        )
        .is_err());
    }

    #[test]
    fn npm_install_shows_npm_upgrade_command() {
        // An npm-installed binary (distribution="binary") is identified by its
        // exec path under node_modules/@kexi/vibe-* and gets the npm command.
        let io = FakeIo::new();
        let http = FakeHttpClient::json(&meta("2.0.0"));
        let env = UpgradeEnv {
            version: "1.0.0",
            distribution: "binary",
            exec_path: "/usr/lib/node_modules/@kexi/vibe-linux-x64/bin/vibe",
            real_path: "/usr/lib/node_modules/@kexi/vibe-linux-x64/bin/vibe",
            is_mac: false,
            is_windows: false,
            eval_dialect: EvalDialect::Posix,
        };
        upgrade_command_run(&io, &http, &env, false, OutputOptions::default()).unwrap();
        let text = io.stderr_text();
        assert!(text.contains("To upgrade:"), "got: {text}");
        assert!(
            text.contains("npm install -g @kexi/vibe@latest"),
            "got: {text}"
        );
    }

    #[test]
    fn deb_distribution_shows_apt_upgrade_command() {
        let io = FakeIo::new();
        let http = FakeHttpClient::json(&meta("2.0.0"));
        upgrade_command_run(
            &io,
            &http,
            &env("1.0.0", "deb"),
            false,
            OutputOptions::default(),
        )
        .unwrap();
        let text = io.stderr_text();
        assert!(text.contains("To upgrade:"));
        assert!(
            text.contains("sudo apt update && sudo apt upgrade vibe"),
            "got: {text}"
        );
    }

    #[test]
    fn unknown_distribution_shows_download_link() {
        // An unrecognized distribution → InstallMethod::Unknown → no command,
        // falls back to the "Download the latest version" link (same shape as
        // the binary branch, but via the unknown path).
        let io = FakeIo::new();
        let http = FakeHttpClient::json(&meta("2.0.0"));
        upgrade_command_run(
            &io,
            &http,
            &env("1.0.0", "some-unknown-channel"),
            false,
            OutputOptions::default(),
        )
        .unwrap();
        let text = io.stderr_text();
        assert!(text.contains("Download the latest version:"), "got: {text}");
        assert!(!text.contains("To upgrade:"));
        assert!(text.contains("releases/tag/v2.0.0"));
    }

    #[test]
    fn too_large_body_is_error_through_command_path() {
        // A response body exceeding MAX_RESPONSE_SIZE (1 MB) is rejected by the
        // defensive size check in fetch_latest_version, surfacing as an Err.
        let big = "x".repeat((MAX_RESPONSE_SIZE as usize) + 1);
        let io = FakeIo::new();
        let http = FakeHttpClient::with(200, Some("application/json"), &big);
        let err = upgrade_command_run(
            &io,
            &http,
            &env("1.0.0", "dev"),
            false,
            OutputOptions::default(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("Response too large"), "got: {err}");
    }

    // --- stale-wrapper notice gate ---

    /// Run `upgrade` with the notice inputs varied, returning captured stderr.
    /// `latest` drives which output path is taken (equal → up-to-date).
    fn run_with_notice_inputs(
        latest: &str,
        check: bool,
        is_windows: bool,
        dialect: EvalDialect,
        shell: Option<&str>,
        opts: OutputOptions,
    ) -> String {
        let io = match shell {
            Some(s) => FakeIo::new().with_env("SHELL", s),
            None => FakeIo::new(),
        };
        let http = FakeHttpClient::json(&meta(latest));
        let env = UpgradeEnv {
            version: "1.0.0",
            distribution: "dev",
            exec_path: "/home/u/.local/bin/vibe",
            real_path: "/home/u/.local/bin/vibe",
            is_mac: false,
            is_windows,
            eval_dialect: dialect,
        };
        upgrade_command_run(&io, &http, &env, check, opts).unwrap();
        io.stderr_text()
    }

    const NOTICE_MARKER: &str = "Run 'vibe doctor' to check yours.";

    /// The reason the notice is emitted BEFORE the network call: the user most
    /// likely to be stuck on a broken wrapper is also the one who is offline or
    /// behind a proxy, and the notice is about their LOCAL shell setup, so it is
    /// true whatever the registry says. Placed after the fetch, the `?` would
    /// swallow it on every failing run.
    #[test]
    fn notice_survives_a_failing_version_fetch() {
        for http in [
            FakeHttpClient::with(500, Some("application/json"), ""),
            FakeHttpClient::error("connection refused"),
        ] {
            let io = FakeIo::new().with_env("SHELL", "/usr/bin/nu");
            let env = UpgradeEnv {
                version: "1.0.0",
                distribution: "dev",
                exec_path: "/home/u/.local/bin/vibe",
                real_path: "/home/u/.local/bin/vibe",
                is_mac: false,
                is_windows: false,
                eval_dialect: EvalDialect::Posix,
            };
            let err =
                upgrade_command_run(&io, &http, &env, false, OutputOptions::default()).unwrap_err();
            // The network failure is still reported as such...
            assert!(matches!(err, VibeError::Network(_)), "got: {err}");
            // ...and the wrapper notice was not lost with it.
            let text = io.stderr_text();
            assert!(text.contains(NOTICE_MARKER), "got: {text}");
        }
    }

    #[test]
    fn notice_is_shown_for_a_nushell_shell_in_both_version_paths() {
        for latest in ["1.0.0", "2.0.0"] {
            let text = run_with_notice_inputs(
                latest,
                false,
                false,
                EvalDialect::Posix,
                Some("/usr/bin/nu"),
                OutputOptions::default(),
            );
            assert!(text.contains(NOTICE_MARKER), "latest={latest} got: {text}");
        }
    }

    #[test]
    fn notice_is_shown_for_a_powershell_shell() {
        let text = run_with_notice_inputs(
            "2.0.0",
            false,
            false,
            EvalDialect::Posix,
            Some("pwsh"),
            OutputOptions::default(),
        );
        assert!(text.contains(NOTICE_MARKER), "got: {text}");
    }

    #[test]
    fn notice_is_shown_on_windows_even_without_shell() {
        // Windows usually leaves $SHELL unset yet PowerShell is the default.
        let text = run_with_notice_inputs(
            "2.0.0",
            false,
            true,
            EvalDialect::Posix,
            None,
            OutputOptions::default(),
        );
        assert!(text.contains(NOTICE_MARKER), "got: {text}");
    }

    #[test]
    fn notice_is_suppressed_for_a_posix_shell_on_a_non_windows_host() {
        for shell in [Some("/bin/bash"), Some("/usr/bin/fish"), None] {
            let text = run_with_notice_inputs(
                "2.0.0",
                false,
                false,
                EvalDialect::Posix,
                shell,
                OutputOptions::default(),
            );
            assert!(!text.contains(NOTICE_MARKER), "shell={shell:?} got: {text}");
        }
    }

    #[test]
    fn notice_is_suppressed_when_a_new_wrapper_requested_its_dialect() {
        // The dialect flag proves the wrapper is already the 2.2.0+ one, so the
        // notice would be noise even though $SHELL/the host say nu/Windows.
        for dialect in [EvalDialect::Nushell, EvalDialect::Powershell] {
            let text = run_with_notice_inputs(
                "2.0.0",
                false,
                true,
                dialect,
                Some("/usr/bin/nu"),
                OutputOptions::default(),
            );
            assert!(
                !text.contains(NOTICE_MARKER),
                "dialect={dialect:?} got: {text}"
            );
        }
    }

    #[test]
    fn notice_is_shown_in_the_check_path() {
        let text = run_with_notice_inputs(
            "2.0.0",
            true,
            false,
            EvalDialect::Posix,
            Some("nu"),
            OutputOptions::default(),
        );
        assert!(text.contains(NOTICE_MARKER), "got: {text}");
    }

    #[test]
    fn notice_survives_quiet() {
        let text = run_with_notice_inputs(
            "2.0.0",
            false,
            false,
            EvalDialect::Posix,
            Some("nu"),
            OutputOptions::new(false, true),
        );
        // Everything else is suppressed; the notice is the only line left.
        assert_eq!(text, STALE_WRAPPER_NOTICE);
    }

    #[test]
    fn the_notice_never_echoes_the_shell_value() {
        let text = run_with_notice_inputs(
            "2.0.0",
            false,
            false,
            EvalDialect::Posix,
            Some("/opt/secret-path/nu"),
            OutputOptions::default(),
        );
        assert!(text.contains(NOTICE_MARKER));
        assert!(!text.contains("secret-path"), "got: {text}");
    }

    #[test]
    fn dist_tag_latest_is_authoritative_over_published_versions() {
        // The registry may have a higher version key (e.g. 3.0.0) published while
        // dist-tags.latest still points at 2.0.0 (a prerelease not yet promoted,
        // or a deprecated/unpublished newer version). The command must propose
        // exactly dist-tags.latest, never the max of the `versions` map.
        let body = r#"{
            "dist-tags": { "latest": "2.0.0" },
            "versions": { "1.0.0": {}, "2.0.0": {}, "3.0.0": {} }
        }"#;
        let io = FakeIo::new();
        let http = FakeHttpClient::json(body);
        upgrade_command_run(
            &io,
            &http,
            &env("1.0.0", "dev"),
            false,
            OutputOptions::default(),
        )
        .unwrap();
        let text = io.stderr_text();
        assert!(
            text.contains("A new version is available: 2.0.0"),
            "should propose dist-tags.latest 2.0.0, not the published 3.0.0; got: {text}"
        );
        assert!(!text.contains("3.0.0"), "non-latest version leaked: {text}");
    }
}
