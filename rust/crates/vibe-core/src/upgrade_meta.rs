//! Pure upgrade logic: version parsing/comparison, npm registry meta parsing,
//! install method detection and upgrade-command mapping.
//!
//! Originally ported from `packages/core/src/commands/upgrade.ts`. The latest
//! version is read from the npm registry (the active distribution channel after
//! the JSR distribution was removed in Phase 6). Network IO stays in `http.rs`;
//! everything here is fed strings so it is fully unit-testable.

use crate::error::{Result, VibeError};
use serde::Deserialize;
use std::cmp::Ordering;

/// Installation distribution channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallMethod {
    Npm,
    Homebrew,
    Deb,
    Binary,
    Dev,
    Unknown,
}

/// Parse a semver string into `[major, minor, patch]`.
///
/// Splits off any `+<commit>` suffix, parses the dot-separated numbers, pads
/// with zeros to three parts, and errors if any part is not a number. Matches
/// the TS `parseVersion`.
pub fn parse_version(v: &str) -> Result<[i64; 3]> {
    let semver = v.split('+').next().unwrap_or(v);
    let invalid = || VibeError::Network(format!("Invalid version format: {v}"));

    let mut parts: Vec<i64> = Vec::new();
    for token in semver.split('.') {
        let n = token.parse::<i64>().map_err(|_| invalid())?;
        parts.push(n);
    }
    if parts.is_empty() {
        return Err(invalid());
    }
    while parts.len() < 3 {
        parts.push(0);
    }
    Ok([parts[0], parts[1], parts[2]])
}

/// Compare two semver strings. `Less`/`Greater`/`Equal` by major, then minor,
/// then patch. Errors if either is unparseable.
pub fn compare_versions(a: &str, b: &str) -> Result<Ordering> {
    let pa = parse_version(a)?;
    let pb = parse_version(b)?;
    Ok(pa.cmp(&pb))
}

/// npm registry packument shape (only `dist-tags.latest` matters here).
///
/// `GET https://registry.npmjs.org/@kexi/vibe` returns this; `dist-tags.latest`
/// is the version npm itself resolves for `@kexi/vibe@latest`, so it is the
/// authoritative "latest" for the npm/Homebrew/binary channels we now ship.
#[derive(Debug, Deserialize)]
pub struct NpmPackument {
    #[serde(rename = "dist-tags")]
    pub dist_tags: NpmDistTags,
}

#[derive(Debug, Deserialize)]
pub struct NpmDistTags {
    pub latest: String,
}

/// Parse an npm registry packument body and return the `dist-tags.latest` version.
///
/// Errors on invalid JSON or a missing/empty `latest`. The body is the
/// already-size-capped string from `http.rs`.
pub fn latest_version_from_meta(body: &str) -> Result<String> {
    let meta: NpmPackument = serde_json::from_str(body)
        .map_err(|_| VibeError::Network("Invalid JSON response".to_string()))?;

    let latest = meta.dist_tags.latest;
    if latest.trim().is_empty() {
        return Err(VibeError::Network(
            "No available versions found".to_string(),
        ));
    }
    Ok(latest)
}

/// Detect the install method from the build `distribution` plus npm/homebrew
/// path checks.
///
/// `deb` maps directly. `binary`/`dev` consult the path checks: the npm
/// per-platform packages and the GitHub release ship the SAME binary (built with
/// `distribution="binary"`), so an npm install is only distinguishable at runtime
/// by its exec path under `node_modules/@kexi/vibe-*` — hence `is_npm` (see
/// [`is_npm_path`]) takes precedence, then `is_homebrew` (see
/// [`is_homebrew_path`]), else it stays binary/dev. Anything else is unknown.
pub fn detect_install_method(distribution: &str, is_npm: bool, is_homebrew: bool) -> InstallMethod {
    match distribution {
        "deb" => InstallMethod::Deb,
        "binary" | "dev" => {
            if is_npm {
                return InstallMethod::Npm;
            }
            if is_homebrew {
                return InstallMethod::Homebrew;
            }
            if distribution == "binary" {
                InstallMethod::Binary
            } else {
                InstallMethod::Dev
            }
        }
        _ => InstallMethod::Unknown,
    }
}

/// Whether either the exec path or its realpath sits inside an npm-installed
/// per-platform package (`.../node_modules/@kexi/vibe-<platform>-<arch>/...`).
///
/// The npm shim resolves and execs the binary from that platform package, so an
/// `npm i -g @kexi/vibe` install is identified by this path shape rather than by
/// the baked-in `distribution` (which is `binary`, shared with the GitHub
/// release). Checked on every platform (unlike homebrew, which is macOS-only).
pub fn is_npm_path(exec_path: &str, real_path: &str) -> bool {
    const MARKER: &str = "node_modules/@kexi/vibe-";
    // Normalize Windows separators so the marker matches on every platform.
    let exec = exec_path.replace('\\', "/");
    let real = real_path.replace('\\', "/");
    exec.contains(MARKER) || real.contains(MARKER)
}

/// Whether either the exec path or its realpath sits under a Homebrew prefix.
///
/// macOS-only (`is_mac`); the TS short-circuits to false off darwin. Prefixes
/// are `/opt/homebrew` (Apple Silicon) and `/usr/local` (Intel).
pub fn is_homebrew_path(is_mac: bool, exec_path: &str, real_path: &str) -> bool {
    if !is_mac {
        return false;
    }
    const PREFIXES: [&str; 2] = ["/opt/homebrew", "/usr/local"];
    PREFIXES
        .iter()
        .any(|p| exec_path.starts_with(p) || real_path.starts_with(p))
}

/// The shell command to upgrade for a given method, or `None` when there is no
/// command (binary downloads / unknown show a link instead).
pub fn upgrade_command(method: InstallMethod) -> Option<String> {
    let cmd = match method {
        InstallMethod::Homebrew => "brew upgrade kexi/tap/vibe",
        // The npm package is the headline distribution channel; upgrade in place.
        InstallMethod::Npm => "npm install -g @kexi/vibe@latest",
        InstallMethod::Deb => "sudo apt update && sudo apt upgrade vibe",
        InstallMethod::Binary => return None,
        // Dev builds are produced by `cargo build` (default distribution="dev");
        // the surviving build script is `build:rust` (`build:compile` was deleted).
        InstallMethod::Dev => "pnpm run build:rust",
        InstallMethod::Unknown => return None,
    };
    Some(cmd.to_string())
}

/// Strip the `+<commit>` build-metadata suffix from a version string, returning
/// the bare semver as a `String` (TS `parseSemver`).
///
/// Distinct from [`parse_version`]: that one parses into `[major, minor, patch]`
/// numbers for *comparison* and errors on non-numeric input; this one only trims
/// the `+commit` suffix and returns text, never failing. Used by
/// `commands::upgrade` to display the current version (`parse_semver(env.version)`)
/// without the local build commit.
pub fn parse_semver(version: &str) -> String {
    version.split('+').next().unwrap_or(version).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_pads_and_strips_commit() {
        assert_eq!(parse_version("1.2").unwrap(), [1, 2, 0]);
        assert_eq!(parse_version("1").unwrap(), [1, 0, 0]);
        assert_eq!(parse_version("1.8.1+abc123").unwrap(), [1, 8, 1]);
    }

    #[test]
    fn parse_version_rejects_non_numeric() {
        assert!(parse_version("1.x.0").is_err());
        assert!(parse_version("notaversion").is_err());
    }

    #[test]
    fn compare_versions_orders_correctly() {
        assert_eq!(compare_versions("1.0.0", "1.0.1").unwrap(), Ordering::Less);
        assert_eq!(
            compare_versions("2.0.0", "1.9.9").unwrap(),
            Ordering::Greater
        );
        assert_eq!(compare_versions("1.2.3", "1.2.3").unwrap(), Ordering::Equal);
        // commit suffix is ignored.
        assert_eq!(
            compare_versions("1.2.3+aaa", "1.2.3+bbb").unwrap(),
            Ordering::Equal
        );
    }

    #[test]
    fn latest_version_reads_dist_tag() {
        let body = r#"{
            "dist-tags": { "latest": "1.2.0" },
            "versions": { "1.0.0": {}, "1.2.0": {} }
        }"#;
        assert_eq!(latest_version_from_meta(body).unwrap(), "1.2.0");
    }

    #[test]
    fn latest_version_errors_on_missing_dist_tag() {
        // No dist-tags.latest → cannot determine latest.
        let body = r#"{ "versions": { "1.0.0": {} } }"#;
        assert!(latest_version_from_meta(body).is_err());
    }

    #[test]
    fn latest_version_errors_on_empty_dist_tag() {
        let body = r#"{ "dist-tags": { "latest": "" } }"#;
        assert!(latest_version_from_meta(body).is_err());
    }

    #[test]
    fn latest_version_errors_on_bad_json() {
        assert!(latest_version_from_meta("{ not json").is_err());
    }

    #[test]
    fn detect_install_method_mapping() {
        assert_eq!(
            detect_install_method("deb", false, false),
            InstallMethod::Deb
        );
        assert_eq!(
            detect_install_method("binary", false, false),
            InstallMethod::Binary
        );
        // npm takes precedence over homebrew and the bare binary fallback.
        assert_eq!(
            detect_install_method("binary", true, false),
            InstallMethod::Npm
        );
        assert_eq!(
            detect_install_method("binary", true, true),
            InstallMethod::Npm
        );
        assert_eq!(
            detect_install_method("binary", false, true),
            InstallMethod::Homebrew
        );
        assert_eq!(
            detect_install_method("dev", false, false),
            InstallMethod::Dev
        );
        assert_eq!(
            detect_install_method("dev", false, true),
            InstallMethod::Homebrew
        );
        assert_eq!(
            detect_install_method("dev", true, false),
            InstallMethod::Npm
        );
        assert_eq!(
            detect_install_method("weird", false, false),
            InstallMethod::Unknown
        );
    }

    #[test]
    fn npm_path_detection() {
        assert!(is_npm_path(
            "/usr/lib/node_modules/@kexi/vibe-linux-x64/bin/vibe",
            "/x"
        ));
        // pnpm `.pnpm` farm layout still contains the marker.
        assert!(is_npm_path(
            "/x",
            "/p/node_modules/.pnpm/@kexi+vibe-darwin-arm64@1.8.1/node_modules/@kexi/vibe-darwin-arm64/bin/vibe"
        ));
        // Windows separators are normalized.
        assert!(is_npm_path(
            r"C:\proj\node_modules\@kexi\vibe-linux-x64\bin\vibe",
            "C:/x"
        ));
        assert!(!is_npm_path(
            "/opt/homebrew/bin/vibe",
            "/opt/homebrew/bin/vibe"
        ));
    }

    #[test]
    fn homebrew_path_detection() {
        assert!(is_homebrew_path(true, "/opt/homebrew/bin/vibe", "/x"));
        assert!(is_homebrew_path(true, "/x", "/usr/local/bin/vibe"));
        assert!(!is_homebrew_path(
            true,
            "/home/u/.bin/vibe",
            "/home/u/.bin/vibe"
        ));
        // Off macOS, always false even under a homebrew prefix.
        assert!(!is_homebrew_path(false, "/opt/homebrew/bin/vibe", "/x"));
    }

    #[test]
    fn upgrade_command_per_method() {
        assert_eq!(
            upgrade_command(InstallMethod::Homebrew).as_deref(),
            Some("brew upgrade kexi/tap/vibe")
        );
        assert_eq!(
            upgrade_command(InstallMethod::Npm).as_deref(),
            Some("npm install -g @kexi/vibe@latest")
        );
        assert_eq!(
            upgrade_command(InstallMethod::Deb).as_deref(),
            Some("sudo apt update && sudo apt upgrade vibe")
        );
        assert_eq!(
            upgrade_command(InstallMethod::Dev).as_deref(),
            Some("pnpm run build:rust")
        );
        assert_eq!(upgrade_command(InstallMethod::Binary), None);
        assert_eq!(upgrade_command(InstallMethod::Unknown), None);
    }

    #[test]
    fn parse_semver_strips_commit() {
        assert_eq!(parse_semver("1.8.1+151b08c"), "1.8.1");
        assert_eq!(parse_semver("1.8.1"), "1.8.1");
    }
}
