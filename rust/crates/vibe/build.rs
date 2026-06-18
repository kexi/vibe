//! Build-time generation of vibe's version/build metadata.
//!
//! Replaces the TypeScript `scripts/build.ts` + generated `version.ts`. Values
//! are emitted as `cargo:rustc-env` so they bake into the binary via `env!()`.
//! Each value can be overridden from the environment so reproducible builds
//! (Nix) can inject deterministic data instead of calling git / reading a clock.

use std::process::Command;

fn main() {
    // The Cargo package version is the source of truth for the semver part.
    let pkg_version = env!("CARGO_PKG_VERSION");

    // Short commit hash: env override first (Nix passes `self.shortRev`), then
    // git, then a stable placeholder so source tarballs without .git still build.
    let commit = env_or("VIBE_BUILD_COMMIT", || git_short_rev().unwrap_or_default());

    // `version` carries the `+<commit>` suffix when a commit is known, matching
    // the TS BUILD_INFO.version format (e.g. "1.8.1+151b08c").
    let version = if commit.is_empty() {
        pkg_version.to_string()
    } else {
        format!("{pkg_version}+{commit}")
    };

    let distribution = env_or("VIBE_BUILD_DISTRIBUTION", || "dev".to_string());
    let build_env = env_or("VIBE_BUILD_ENV", || "local".to_string());
    // buildTime is non-reproducible; leave empty unless explicitly provided.
    let build_time = env_or("VIBE_BUILD_TIME", String::new);

    emit("VIBE_VERSION", &version);
    emit("VIBE_REPOSITORY", "git+https://github.com/kexi/vibe.git");
    emit("VIBE_TARGET", &std::env::var("TARGET").unwrap_or_default());
    emit("VIBE_DISTRIBUTION", &distribution);
    emit("VIBE_BUILD_TIME", &build_time);
    emit("VIBE_BUILD_ENV", &build_env);

    // Rebuild when the commit moves so the embedded version stays accurate.
    println!("cargo:rerun-if-env-changed=VIBE_BUILD_COMMIT");
    println!("cargo:rerun-if-changed=../../../.git/HEAD");
}

fn emit(key: &str, value: &str) {
    println!("cargo:rustc-env={key}={value}");
}

fn env_or(key: &str, fallback: impl FnOnce() -> String) -> String {
    match std::env::var(key) {
        Ok(value) if !value.is_empty() => value,
        _ => fallback(),
    }
}

fn git_short_rev() -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let rev = String::from_utf8(output.stdout).ok()?;
    let rev = rev.trim().to_string();
    if rev.is_empty() {
        None
    } else {
        Some(rev)
    }
}
