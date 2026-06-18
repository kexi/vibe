//! Lifecycle hook execution (`pre_start`/`post_start`/`pre_clean`/`post_clean`).
//!
//! Ported from `packages/core/src/utils/hooks.ts`. The TS ran each command via
//! the runtime's `process.run` with `sh -c <cmd>` (or `cmd /c` on Windows),
//! inheriting the parent env plus `VIBE_WORKTREE_PATH`/`VIBE_ORIGIN_PATH`. Here a
//! [`HookRunner`] seam (security point #1) makes those spawns injectable so the
//! cwd/env/order are unit-testable without running real shells.
//!
//! Output behavior (TS parity): with NO tracker, hook stdout is forwarded to
//! STDERR (so it never pollutes the eval'd `cd` on stdout); with a tracker,
//! stdout is suppressed. A failed hook ALWAYS shows its stderr, then raises a
//! [`VibeError::HookExecution`] (warning severity, exit 0 per `VibeError`).

use crate::error::{Result, VibeError};
use crate::io::Io;
use crate::output::warn_log;
use crate::progress::{NodeId, ProgressTracker};

/// Captured result of one hook command.
pub struct HookOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a single shell hook command. `env` are overlays ON TOP of the inherited
/// parent environment (do NOT `env_clear` — TS parity).
pub trait HookRunner {
    fn run_hook(&self, cmd: &str, cwd: &str, env: &[(&str, &str)]) -> Result<HookOutput>;
}

/// Forward through a reference (so `&dyn HookRunner` satisfies `impl HookRunner`
/// in the generic `run_hooks`, letting commands pass their `&dyn HookRunner`
/// seam without monomorphizing on every concrete runner).
impl<T: HookRunner + ?Sized> HookRunner for &T {
    fn run_hook(&self, cmd: &str, cwd: &str, env: &[(&str, &str)]) -> Result<HookOutput> {
        (**self).run_hook(cmd, cwd, env)
    }
}

/// Production [`HookRunner`]: `/bin/sh -c <cmd>` (Unix) / `cmd /c <cmd>` (Windows).
pub struct RealHookRunner;

impl HookRunner for RealHookRunner {
    fn run_hook(&self, cmd: &str, cwd: &str, env: &[(&str, &str)]) -> Result<HookOutput> {
        let mut command = if cfg!(windows) {
            let mut c = std::process::Command::new("cmd");
            c.arg("/c").arg(cmd);
            c
        } else {
            let mut c = std::process::Command::new("/bin/sh");
            c.arg("-c").arg(cmd);
            c
        };
        command.current_dir(cwd);
        // Inherit parent env (default) + overlays. NO env_clear (TS parity).
        for (k, v) in env {
            command.env(k, v);
        }
        let output = command.output().map_err(|e| VibeError::HookExecution {
            hook_command: cmd.to_string(),
            message: e.to_string(),
        })?;
        Ok(HookOutput {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

/// The two hook env overlays the TS always set.
pub struct HookEnv<'a> {
    pub worktree_path: &'a str,
    pub origin_path: &'a str,
}

/// Optional progress wiring: a tracker plus the task id per command (1:1 with
/// `commands`). When present, stdout is suppressed and per-task state is updated.
pub struct HookTrackerInfo<'a> {
    pub tracker: &'a dyn ProgressTracker,
    pub task_ids: &'a [NodeId],
}

/// Run `commands` sequentially in `cwd` with the `VIBE_*` overlays.
///
/// On the first failure: shows the hook's stderr, fails the task (if tracking),
/// and returns a [`VibeError::HookExecution`] (warning, exit 0). Subsequent
/// commands do not run.
pub fn run_hooks(
    io: &impl Io,
    runner: &impl HookRunner,
    commands: &[String],
    cwd: &str,
    env: &HookEnv,
    tracker: Option<&HookTrackerInfo>,
) -> Result<()> {
    let overlays = [
        ("VIBE_WORKTREE_PATH", env.worktree_path),
        ("VIBE_ORIGIN_PATH", env.origin_path),
    ];

    for (i, cmd) in commands.iter().enumerate() {
        if let Some(info) = tracker {
            if let Some(id) = info.task_ids.get(i) {
                info.tracker.start_task(*id);
            }
        }

        let result = runner.run_hook(cmd, cwd, &overlays)?;

        // No tracker → forward hook stdout to STDERR (never stdout). With a
        // tracker, suppress stdout to keep the progress display clean.
        if tracker.is_none() && !result.stdout.is_empty() {
            // The TS wrote the bytes verbatim; we trim a single trailing newline
            // because writeln_stderr re-adds one (avoids a blank line per hook).
            let text = result.stdout.strip_suffix('\n').unwrap_or(&result.stdout);
            io.writeln_stderr(text);
        }

        let succeeded = result.code == 0;
        if !succeeded {
            if let Some(info) = tracker {
                if let Some(id) = info.task_ids.get(i) {
                    info.tracker
                        .fail_task(*id, &format!("Exit code {}", result.code));
                }
            }
            // Failed hooks ALWAYS show stderr (regardless of tracker).
            if !result.stderr.is_empty() {
                let text = result.stderr.strip_suffix('\n').unwrap_or(&result.stderr);
                warn_log(io, text);
            }
            return Err(VibeError::HookExecution {
                hook_command: cmd.clone(),
                message: format!("exit code {}", result.code),
            });
        }

        if let Some(info) = tracker {
            if let Some(id) = info.task_ids.get(i) {
                info.tracker.complete_task(*id);
            }
        }
    }

    Ok(())
}

#[cfg(any(test, feature = "test-util"))]
pub use fake::FakeHookRunner;

#[cfg(any(test, feature = "test-util"))]
mod fake {
    use super::{HookOutput, HookRunner};
    use crate::error::Result;
    use std::cell::RefCell;

    /// One recorded hook invocation: `(cmd, cwd, env overlays)`.
    pub type HookCall = (String, String, Vec<(String, String)>);

    /// Records every [`HookCall`] and serves scripted outcomes per command.
    pub struct FakeHookRunner {
        /// Each invocation, in order.
        pub calls: RefCell<Vec<HookCall>>,
        /// Exit code returned for a command whose text ENDS WITH the key suffix;
        /// commands not listed return 0.
        fail_suffix: Option<(String, i32)>,
        stdout: String,
        stderr: String,
    }

    impl FakeHookRunner {
        /// All hooks succeed (exit 0) with no output.
        pub fn ok() -> Self {
            FakeHookRunner {
                calls: RefCell::new(vec![]),
                fail_suffix: None,
                stdout: String::new(),
                stderr: String::new(),
            }
        }

        /// All hooks succeed but emit `stdout` (to test stdout→stderr forwarding).
        pub fn ok_with_stdout(stdout: &str) -> Self {
            FakeHookRunner {
                calls: RefCell::new(vec![]),
                fail_suffix: None,
                stdout: stdout.to_string(),
                stderr: String::new(),
            }
        }

        /// Any hook whose command ENDS WITH `suffix` fails with `code` and emits
        /// `stderr`; others succeed.
        pub fn failing_on(suffix: &str, code: i32, stderr: &str) -> Self {
            FakeHookRunner {
                calls: RefCell::new(vec![]),
                fail_suffix: Some((suffix.to_string(), code)),
                stdout: String::new(),
                stderr: stderr.to_string(),
            }
        }
    }

    impl HookRunner for FakeHookRunner {
        fn run_hook(&self, cmd: &str, cwd: &str, env: &[(&str, &str)]) -> Result<HookOutput> {
            self.calls.borrow_mut().push((
                cmd.to_string(),
                cwd.to_string(),
                env.iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            ));
            if let Some((suffix, code)) = &self.fail_suffix {
                if cmd.ends_with(suffix.as_str()) {
                    return Ok(HookOutput {
                        code: *code,
                        stdout: String::new(),
                        stderr: self.stderr.clone(),
                    });
                }
            }
            Ok(HookOutput {
                code: 0,
                stdout: self.stdout.clone(),
                stderr: String::new(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::FakeIo;
    use crate::progress::RecordingTracker;

    fn cmds(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn runs_commands_in_order_with_cwd_and_env() {
        let io = FakeIo::new();
        let runner = FakeHookRunner::ok();
        let env = HookEnv {
            worktree_path: "/wt",
            origin_path: "/main",
        };
        run_hooks(
            &io,
            &runner,
            &cmds(&["echo a", "echo b"]),
            "/run/dir",
            &env,
            None,
        )
        .unwrap();

        let calls = runner.calls.borrow();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "echo a");
        assert_eq!(calls[1].0, "echo b");
        // cwd threaded through.
        assert_eq!(calls[0].1, "/run/dir");
        // VIBE_* overlays present with the right values.
        let env0 = &calls[0].2;
        assert!(env0
            .iter()
            .any(|(k, v)| k == "VIBE_WORKTREE_PATH" && v == "/wt"));
        assert!(env0
            .iter()
            .any(|(k, v)| k == "VIBE_ORIGIN_PATH" && v == "/main"));
    }

    #[test]
    fn stdout_is_forwarded_to_stderr_without_tracker() {
        let io = FakeIo::new();
        let runner = FakeHookRunner::ok_with_stdout("hook said hi");
        let env = HookEnv {
            worktree_path: "/wt",
            origin_path: "/main",
        };
        run_hooks(&io, &runner, &cmds(&["echo hi"]), "/d", &env, None).unwrap();
        assert!(io.stderr_text().contains("hook said hi"));
    }

    #[test]
    fn failing_hook_shows_stderr_and_errors_warning_severity() {
        let io = FakeIo::new();
        let runner = FakeHookRunner::failing_on("npm ci", 1, "boom from npm");
        let env = HookEnv {
            worktree_path: "/wt",
            origin_path: "/main",
        };
        let err = run_hooks(&io, &runner, &cmds(&["npm ci"]), "/d", &env, None).unwrap_err();
        assert!(matches!(err, VibeError::HookExecution { .. }));
        // Hook failure is warning severity, exit 0.
        assert_eq!(err.exit_code(), 0);
        assert!(io.stderr_text().contains("boom from npm"));
    }

    #[test]
    fn stops_at_first_failure() {
        let io = FakeIo::new();
        let runner = FakeHookRunner::failing_on("first", 2, "nope");
        let env = HookEnv {
            worktree_path: "/wt",
            origin_path: "/main",
        };
        let _ = run_hooks(&io, &runner, &cmds(&["first", "second"]), "/d", &env, None);
        // Only the first command ran.
        assert_eq!(runner.calls.borrow().len(), 1);
    }

    #[test]
    fn tracker_records_start_complete_and_suppresses_stdout() {
        let io = FakeIo::new();
        let runner = FakeHookRunner::ok_with_stdout("noisy output");
        let tracker = RecordingTracker::new();
        let phase = tracker.add_phase("Pre-start hooks");
        let ids = vec![tracker.add_task(phase, "echo a")];
        let info = HookTrackerInfo {
            tracker: &tracker,
            task_ids: &ids,
        };
        let env = HookEnv {
            worktree_path: "/wt",
            origin_path: "/main",
        };
        run_hooks(&io, &runner, &cmds(&["echo a"]), "/d", &env, Some(&info)).unwrap();

        // stdout suppressed when tracking.
        assert!(!io.stderr_text().contains("noisy output"));
        // start + complete recorded for the task.
        let events = tracker.events();
        assert!(events
            .iter()
            .any(|e| matches!(e, crate::progress::TrackerEvent::Start(_))));
        assert!(events
            .iter()
            .any(|e| matches!(e, crate::progress::TrackerEvent::Complete(_))));
    }

    #[test]
    fn tracker_records_fail_on_failure() {
        let io = FakeIo::new();
        let runner = FakeHookRunner::failing_on("bad", 3, "err");
        let tracker = RecordingTracker::new();
        let phase = tracker.add_phase("Pre-start hooks");
        let ids = vec![tracker.add_task(phase, "bad")];
        let info = HookTrackerInfo {
            tracker: &tracker,
            task_ids: &ids,
        };
        let env = HookEnv {
            worktree_path: "/wt",
            origin_path: "/main",
        };
        let _ = run_hooks(&io, &runner, &cmds(&["bad"]), "/d", &env, Some(&info));
        assert!(tracker
            .events()
            .iter()
            .any(|e| matches!(e, crate::progress::TrackerEvent::Fail(_, _))));
    }
}
