//! Build/version metadata, baked in by `build.rs`.
//!
//! Reproduces the `--version` output of the TypeScript CLI (`main.ts` lines
//! 138-144): a multi-line block written to stderr, with platform/arch detected
//! at runtime via `std::env::consts` rather than recorded at build time.

pub const VERSION: &str = env!("VIBE_VERSION");
pub const REPOSITORY: &str = env!("VIBE_REPOSITORY");
pub const TARGET: &str = env!("VIBE_TARGET");
pub const DISTRIBUTION: &str = env!("VIBE_DISTRIBUTION");
pub const BUILD_TIME: &str = env!("VIBE_BUILD_TIME");
pub const BUILD_ENV: &str = env!("VIBE_BUILD_ENV");

/// Print the multi-line version block to stderr, matching the TS format.
pub fn print_version() {
    let platform = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    eprintln!("vibe {VERSION}");
    eprintln!("Platform: {platform}-{arch} ({TARGET})");
    eprintln!("Distribution: {DISTRIBUTION}");
    eprintln!("Built: {BUILD_TIME} ({BUILD_ENV})");
    eprintln!();
    eprintln!("{REPOSITORY}#readme");
}
