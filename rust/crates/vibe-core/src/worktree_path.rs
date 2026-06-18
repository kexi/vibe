//! Resolve the on-disk worktree path, optionally via a user `path_script`.
//!
//! Ported from `packages/core/src/utils/worktree-path.ts`. The default path is
//! `{dirname(repo_root)}/{repo_name}-{sanitized_branch}`. When a `path_script`
//! is configured (`.vibe.toml`/`.vibe.local.toml` `worktree.path_script`, else
//! `settings.json` `worktree.path_script`), it is executed and its stdout used
//! as the path.
//!
//! SECURITY-SENSITIVE: the script runs with `std::process::Command::new(cmd)`
//! (NO shell), so the path_script string is the executable, not a shell line —
//! there is no shell metacharacter injection surface. It inherits the full
//! parent environment plus four `VIBE_*` overlays (TS parity; we intentionally
//! do NOT `env_clear`). The is-file check FOLLOWS symlinks via `fs::metadata`
//! (TS parity); the metadata→spawn TOCTOU is an accepted residual risk because
//! the script path comes from a trusted (already-verified) config. We do NOT
//! canonicalize before spawn, and we only require the script *output* to be an
//! absolute path (no containment check) — all three are deliberate TS parity.

use crate::config::VibeConfig;
use crate::error::{Result, VibeError};
use crate::io::Io;
use crate::settings::VibeSettings;
use std::path::Path;

/// Substitution context exposed to a `path_script` via `VIBE_*` env vars and
/// used to build the default path.
pub struct WorktreePathContext {
    pub repo_name: String,
    pub branch_name: String,
    pub sanitized_branch: String,
    pub repo_root: String,
}

/// Captured result of running a `path_script`.
pub struct ScriptOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a `path_script` executable. Abstracted so tests can avoid a real spawn.
///
/// `cmd` is the resolved script path (the executable itself — NOT a shell line).
/// `env` are the `VIBE_*` overlays to add ON TOP of the inherited parent env.
pub trait ScriptRunner {
    fn run_script(&self, cmd: &str, env: &[(&str, &str)]) -> Result<ScriptOutput>;
}

/// Production [`ScriptRunner`] over `std::process::Command`.
///
/// Inherits the parent environment (no `env_clear`) and layers the four
/// `VIBE_*` overlays, then captures stdout/stderr. The executable is `cmd`
/// directly — there is no shell, so no metacharacter expansion.
pub struct RealScriptRunner;

impl ScriptRunner for RealScriptRunner {
    fn run_script(&self, cmd: &str, env: &[(&str, &str)]) -> Result<ScriptOutput> {
        let mut command = std::process::Command::new(cmd);
        // Inherit parent env (default) + the four overlays. NO env_clear: the TS
        // spread `...runtime.env.toObject()` then added the VIBE_* keys.
        for (k, v) in env {
            command.env(k, v);
        }
        let output = command.output().map_err(|e| {
            VibeError::FileSystem(format!("Failed to run worktree path script {cmd}: {e}"))
        })?;
        Ok(ScriptOutput {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

/// Resolve the worktree path for `ctx`.
///
/// Priority: `config.worktree.path_script` > `settings.worktree.path_script` >
/// default `{dirname(repo_root)}/{repo_name}-{sanitized_branch}`. A configured
/// script is executed via `script_runner`; the default is pure string assembly.
pub fn resolve_worktree_path(
    io: &impl Io,
    script_runner: &impl ScriptRunner,
    config: Option<&VibeConfig>,
    settings: &VibeSettings,
    ctx: &WorktreePathContext,
) -> Result<String> {
    let path_script = config
        .and_then(|c| c.worktree.as_ref())
        .and_then(|w| w.path_script.as_deref())
        .or_else(|| {
            settings
                .worktree
                .as_ref()
                .and_then(|w| w.path_script.as_deref())
        });

    if let Some(script) = path_script {
        return execute_path_script(io, script_runner, script, ctx);
    }

    // Default: {parentDir}/{repoName}-{sanitizedBranch}.
    let parent = dirname(&ctx.repo_root);
    Ok(join(
        &parent,
        &format!("{}-{}", ctx.repo_name, ctx.sanitized_branch),
    ))
}

/// Execute a configured `path_script` and return its (absolute) output path.
fn execute_path_script(
    io: &impl Io,
    script_runner: &impl ScriptRunner,
    script_path: &str,
    ctx: &WorktreePathContext,
) -> Result<String> {
    // `~` expansion with HOME validation. The TS used a SUBSTRING `..` check
    // (`!home.includes("..")`), which we reproduce exactly for byte parity even
    // though it is coarser than a component check.
    let home = io.home().unwrap_or_default();
    let is_valid_home = !home.is_empty() && Path::new(&home).is_absolute() && !home.contains("..");
    let starts_with_tilde = script_path.starts_with('~');
    if starts_with_tilde && !is_valid_home {
        return Err(VibeError::Configuration(
            "Cannot expand ~ in path_script: HOME environment variable is invalid or not set."
                .to_string(),
        ));
    }
    let expanded = if starts_with_tilde {
        format!("{home}{}", &script_path[1..])
    } else {
        script_path.to_string()
    };

    // Relative paths resolve against repo_root.
    let resolved = if Path::new(&expanded).is_absolute() {
        expanded
    } else {
        join(&ctx.repo_root, &expanded)
    };

    // Existence + is-file check, FOLLOWING symlinks (fs::metadata, TS parity).
    match std::fs::metadata(&resolved) {
        Ok(meta) => {
            if !meta.is_file() {
                return Err(VibeError::Configuration(format!(
                    "Worktree path script is not a file: {resolved}"
                )));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(VibeError::Configuration(format!(
                "Worktree path script not found: {resolved}"
            )));
        }
        Err(e) => {
            return Err(VibeError::FileSystem(format!(
                "Failed to stat worktree path script {resolved}: {e}"
            )));
        }
    }

    // Run with the four VIBE_* overlays on top of the inherited parent env.
    let env = [
        ("VIBE_REPO_NAME", ctx.repo_name.as_str()),
        ("VIBE_BRANCH_NAME", ctx.branch_name.as_str()),
        ("VIBE_SANITIZED_BRANCH", ctx.sanitized_branch.as_str()),
        ("VIBE_REPO_ROOT", ctx.repo_root.as_str()),
    ];
    let result = script_runner.run_script(&resolved, &env)?;

    if result.code != 0 {
        return Err(VibeError::Configuration(format!(
            "Worktree path script failed: {}",
            result.stderr
        )));
    }

    let path = result.stdout.trim().to_string();
    let is_empty = path.is_empty();
    let is_relative = !Path::new(&path).is_absolute();
    if is_empty || is_relative {
        return Err(VibeError::Configuration(format!(
            "Worktree path script must output an absolute path, got: {path}"
        )));
    }

    Ok(path)
}

/// `path.dirname`-equivalent: the parent of `path` as a string, or `.` / `/`.
///
/// Matches node `path.dirname` for the cases we hit: a trailing-slash-free
/// absolute path returns its parent; a root returns the root; a bare segment
/// returns `.`.
fn dirname(path: &str) -> String {
    let p = Path::new(path);
    match p.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_string_lossy().into_owned(),
        // No parent or empty parent → node returns `.` for relative, `/` stays
        // as the root case handled by parent() == Some("/")? Treat empty as `.`.
        _ => ".".to_string(),
    }
}

/// `path.join(a, b)`-equivalent for the two-arg case (forward-slash join).
fn join(a: &str, b: &str) -> String {
    Path::new(a).join(b).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::WorktreeConfig;
    use crate::io::FakeIo;
    use crate::settings::SettingsWorktree;
    use std::cell::RefCell;
    use vibe_test_support::Fixture;

    /// Records the cmd + the (key, value) env overlays a script was asked to run.
    type SeenInvocation = (String, Vec<(String, String)>);

    /// A ScriptRunner that returns a canned result and records the cmd + env it
    /// was asked to run (so we never spawn a real process in unit tests).
    struct FakeScriptRunner {
        code: i32,
        stdout: String,
        stderr: String,
        seen: RefCell<Option<SeenInvocation>>,
    }
    impl FakeScriptRunner {
        fn ok(stdout: &str) -> Self {
            FakeScriptRunner {
                code: 0,
                stdout: stdout.to_string(),
                stderr: String::new(),
                seen: RefCell::new(None),
            }
        }
        fn fail(code: i32, stderr: &str) -> Self {
            FakeScriptRunner {
                code,
                stdout: String::new(),
                stderr: stderr.to_string(),
                seen: RefCell::new(None),
            }
        }
    }
    impl ScriptRunner for FakeScriptRunner {
        fn run_script(&self, cmd: &str, env: &[(&str, &str)]) -> Result<ScriptOutput> {
            *self.seen.borrow_mut() = Some((
                cmd.to_string(),
                env.iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            ));
            Ok(ScriptOutput {
                code: self.code,
                stdout: self.stdout.clone(),
                stderr: self.stderr.clone(),
            })
        }
    }

    fn ctx(repo_root: &str) -> WorktreePathContext {
        WorktreePathContext {
            repo_name: "myrepo".into(),
            branch_name: "feat/x".into(),
            sanitized_branch: "feat-x".into(),
            repo_root: repo_root.into(),
        }
    }

    fn settings_with_script(script: Option<&str>) -> VibeSettings {
        let mut s = VibeSettings::default_settings();
        s.worktree = script.map(|p| SettingsWorktree {
            path_script: Some(p.to_string()),
        });
        s
    }

    #[test]
    fn default_path_without_script() {
        let io = FakeIo::new();
        let runner = FakeScriptRunner::ok("");
        let settings = settings_with_script(None);
        let path =
            resolve_worktree_path(&io, &runner, None, &settings, &ctx("/home/u/myrepo")).unwrap();
        assert_eq!(path, "/home/u/myrepo-feat-x");
        // The script was never invoked.
        assert!(runner.seen.borrow().is_none());
    }

    #[test]
    fn config_script_takes_precedence_over_settings_script() {
        let fx = Fixture::new();
        // An absolute, existing script file.
        let script = fx.write("from-config.sh", "#!/bin/sh\n");
        let io = FakeIo::new();
        let runner = FakeScriptRunner::ok("/abs/output");
        let config = VibeConfig {
            worktree: Some(WorktreeConfig {
                path_script: Some(script.to_string_lossy().into_owned()),
            }),
            ..Default::default()
        };
        // settings ALSO has a script, but config wins.
        let settings = settings_with_script(Some("/never/used.sh"));
        let path =
            resolve_worktree_path(&io, &runner, Some(&config), &settings, &ctx("/repo")).unwrap();
        assert_eq!(path, "/abs/output");
        // It ran the CONFIG script, with the four VIBE_* overlays.
        let (cmd, env) = runner.seen.borrow().clone().unwrap();
        assert_eq!(cmd, script.to_string_lossy());
        assert!(env
            .iter()
            .any(|(k, v)| k == "VIBE_REPO_NAME" && v == "myrepo"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "VIBE_BRANCH_NAME" && v == "feat/x"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "VIBE_SANITIZED_BRANCH" && v == "feat-x"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "VIBE_REPO_ROOT" && v == "/repo"));
    }

    #[test]
    fn settings_script_used_when_no_config_script() {
        let fx = Fixture::new();
        let script = fx.write("s.sh", "#!/bin/sh\n");
        let io = FakeIo::new();
        let runner = FakeScriptRunner::ok("/from/settings");
        let settings = settings_with_script(Some(script.to_str().unwrap()));
        let path = resolve_worktree_path(&io, &runner, None, &settings, &ctx("/repo")).unwrap();
        assert_eq!(path, "/from/settings");

        // R-6: the SETTINGS-script path also gets all four VIBE_* overlays, with
        // the raw branch (`feat/x`) and the sanitized one (`feat-x`) DISTINCT.
        let (_cmd, env) = runner.seen.borrow().clone().unwrap();
        let get = |k: &str| {
            env.iter()
                .find(|(ek, _)| ek == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| panic!("missing env {k}"))
        };
        assert_eq!(get("VIBE_REPO_NAME"), "myrepo");
        assert_eq!(get("VIBE_REPO_ROOT"), "/repo");
        // The raw vs sanitized distinction is load-bearing: `/` → `-`.
        assert_eq!(get("VIBE_BRANCH_NAME"), "feat/x");
        assert_eq!(get("VIBE_SANITIZED_BRANCH"), "feat-x");
        assert_ne!(
            get("VIBE_BRANCH_NAME"),
            get("VIBE_SANITIZED_BRANCH"),
            "raw and sanitized branch must differ"
        );
    }

    #[test]
    fn relative_script_path_resolves_against_repo_root() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let _ = fx.write("repo/script.sh", "#!/bin/sh\n");
        let io = FakeIo::new();
        let runner = FakeScriptRunner::ok("/out");
        let settings = settings_with_script(Some("script.sh")); // relative
        resolve_worktree_path(&io, &runner, None, &settings, &ctx(repo.to_str().unwrap())).unwrap();
        let (cmd, _) = runner.seen.borrow().clone().unwrap();
        assert_eq!(cmd, repo.join("script.sh").to_string_lossy());
    }

    #[test]
    fn script_not_found_errors() {
        let io = FakeIo::new();
        let runner = FakeScriptRunner::ok("/x");
        let settings = settings_with_script(Some("/no/such/script.sh"));
        let err = resolve_worktree_path(&io, &runner, None, &settings, &ctx("/repo")).unwrap_err();
        assert!(
            err.to_string().contains("Worktree path script not found"),
            "msg: {err}"
        );
    }

    #[test]
    fn script_is_a_directory_errors() {
        let fx = Fixture::new();
        let dir = fx.mkdir("scriptdir");
        let io = FakeIo::new();
        let runner = FakeScriptRunner::ok("/x");
        let settings = settings_with_script(Some(dir.to_str().unwrap()));
        let err = resolve_worktree_path(&io, &runner, None, &settings, &ctx("/repo")).unwrap_err();
        assert!(err.to_string().contains("is not a file"), "msg: {err}");
    }

    #[test]
    fn nonzero_exit_reports_stderr() {
        let fx = Fixture::new();
        let script = fx.write("s.sh", "#!/bin/sh\n");
        let io = FakeIo::new();
        let runner = FakeScriptRunner::fail(1, "boom from script");
        let settings = settings_with_script(Some(script.to_str().unwrap()));
        let err = resolve_worktree_path(&io, &runner, None, &settings, &ctx("/repo")).unwrap_err();
        assert!(
            err.to_string()
                .contains("Worktree path script failed: boom from script"),
            "msg: {err}"
        );
    }

    #[test]
    fn empty_output_errors() {
        let fx = Fixture::new();
        let script = fx.write("s.sh", "#!/bin/sh\n");
        let io = FakeIo::new();
        let runner = FakeScriptRunner::ok("   \n");
        let settings = settings_with_script(Some(script.to_str().unwrap()));
        let err = resolve_worktree_path(&io, &runner, None, &settings, &ctx("/repo")).unwrap_err();
        assert!(
            err.to_string().contains("must output an absolute path"),
            "msg: {err}"
        );
    }

    #[test]
    fn relative_output_errors() {
        let fx = Fixture::new();
        let script = fx.write("s.sh", "#!/bin/sh\n");
        let io = FakeIo::new();
        let runner = FakeScriptRunner::ok("relative/path\n");
        let settings = settings_with_script(Some(script.to_str().unwrap()));
        let err = resolve_worktree_path(&io, &runner, None, &settings, &ctx("/repo")).unwrap_err();
        assert!(
            err.to_string().contains("must output an absolute path"),
            "msg: {err}"
        );
    }

    #[test]
    fn tilde_expansion_uses_home() {
        let fx = Fixture::new();
        // Put the script under a fake HOME so `~/s.sh` resolves to it.
        let home = fx.path().to_str().unwrap();
        let script = fx.write("s.sh", "#!/bin/sh\n");
        let io = FakeIo::new().with_env("HOME", home);
        let runner = FakeScriptRunner::ok("/out");
        let settings = settings_with_script(Some("~/s.sh"));
        resolve_worktree_path(&io, &runner, None, &settings, &ctx("/repo")).unwrap();
        let (cmd, _) = runner.seen.borrow().clone().unwrap();
        assert_eq!(cmd, script.to_string_lossy());
    }

    #[test]
    fn tilde_with_invalid_home_errors() {
        let io = FakeIo::new().with_env("HOME", ""); // empty → invalid
        let runner = FakeScriptRunner::ok("/out");
        let settings = settings_with_script(Some("~/s.sh"));
        let err = resolve_worktree_path(&io, &runner, None, &settings, &ctx("/repo")).unwrap_err();
        assert!(
            err.to_string().contains("Cannot expand ~ in path_script"),
            "msg: {err}"
        );
    }

    #[test]
    fn tilde_with_dotdot_home_errors() {
        // HOME containing `..` is rejected by the substring check (TS parity).
        let io = FakeIo::new().with_env("HOME", "/home/../etc");
        let runner = FakeScriptRunner::ok("/out");
        let settings = settings_with_script(Some("~/s.sh"));
        let err = resolve_worktree_path(&io, &runner, None, &settings, &ctx("/repo")).unwrap_err();
        assert!(err.to_string().contains("Cannot expand ~ in path_script"));
    }
}
