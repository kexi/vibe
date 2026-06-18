//! `vibe config`: print the settings file path and current settings JSON.
//!
//! Ported from `packages/core/src/commands/config.ts`. Output goes to stderr via
//! the [`Io`] (stdout is reserved for the eval contract); the JSON is the
//! in-memory settings pretty-printed, matching the TS `JSON.stringify(settings,
//! null, 2)` (note: without the `$schema` key, which only the on-disk file
//! carries).

use crate::commands::Outcome;
use crate::error::{Result, VibeError};
use crate::io::Io;
use crate::output::{log, OutputOptions};
use crate::settings::RepoResolver;
use crate::settings_io::{get_settings_path, load_user_settings};

/// Run `vibe config`. `version` is the binary build version (for any settings
/// save the load might trigger via migration).
pub fn config_command(
    io: &impl Io,
    resolver: &impl RepoResolver,
    version: &str,
) -> Result<Outcome> {
    let opts = OutputOptions::default();

    let home = io.home().filter(|h| !h.is_empty()).ok_or_else(|| {
        VibeError::Configuration("HOME environment variable is not set".to_string())
    })?;
    let settings_path = get_settings_path(&home)?;
    let settings = load_user_settings(io, resolver, version)?;

    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| VibeError::Configuration(format!("Failed to serialize settings: {e}")))?;

    log(
        io,
        &format!("Settings file: {}", settings_path.display()),
        opts,
    );
    log(io, "", opts);
    log(io, &json, opts);

    Ok(Outcome::none())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::RepoInfo;
    use crate::io::FakeIo;
    use vibe_test_support::Fixture;

    struct NoResolver;
    impl RepoResolver for NoResolver {
        fn repo_info(&self, _path: &str) -> Option<RepoInfo> {
            None
        }
        fn hash_file(&self, _path: &str) -> std::result::Result<String, String> {
            Err("unused".into())
        }
    }

    #[test]
    fn prints_path_and_default_settings_json() {
        let fx = Fixture::new();
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let outcome = config_command(&io, &NoResolver, "1.0.0").unwrap();
        assert_eq!(outcome, Outcome::none());

        let text = io.stderr_text();
        assert!(text.contains("Settings file:"));
        assert!(text.contains(".config/vibe/settings.json"));
        // Default settings serialize without `$schema`.
        assert!(text.contains("\"version\": 3"));
        assert!(!text.contains("$schema"));
    }

    #[test]
    fn errors_when_home_unset() {
        let io = FakeIo::new(); // no HOME
        assert!(config_command(&io, &NoResolver, "1.0.0").is_err());
    }

    #[test]
    fn surfaces_load_user_settings_error() {
        // A corrupt settings.json makes load_user_settings return Err (a JSON
        // parse failure is propagated, not swallowed); config must surface it.
        let fx = Fixture::new();
        let _ = fx.write(".config/vibe/settings.json", "{ not valid json");
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let err = config_command(&io, &NoResolver, "1.0.0").unwrap_err();
        // Exit code 1 (fatal Configuration error), not a panic / silent default.
        assert_eq!(err.exit_code(), 1);
        assert!(
            err.to_string().contains("Failed to parse settings.json"),
            "got: {err}"
        );
    }
}
