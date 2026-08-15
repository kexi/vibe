//! The `[summary]` command seam: run one shell command with a JSON payload on
//! stdin, a deadline, and captured output.
//!
//! # Why not reuse [`HookRunner`](crate::hooks::HookRunner)
//!
//! A hook's stdout is *human* output that `run_hooks` forwards to stderr; a
//! summary command's stdout is a *machine* payload this crate parses. Widening
//! `HookRunner` with stdin and a timeout would give every hook call site two
//! parameters it must pass `None` for, and would put the two opposite stdout
//! contracts behind one trait — the next reader could not tell from the
//! signature which one applies. A separate trait states the contract instead.
//!
//! # Why every stream gets a thread
//!
//! With a piped stdin AND piped stdout/stderr, writing the payload before
//! reading is a deadlock: a command that echoes its input (the common shape,
//! e.g. `jq`) fills the stdout pipe buffer and blocks, so it stops draining
//! stdin, so our write blocks forever. Each stream therefore gets its own
//! thread, and the parent only waits on the child.
//!
//! # Why `try_wait` polling rather than a blocking `wait`
//!
//! [`std::process::Child::wait`] has no timeout, and the standard library
//! offers no deadline form. Polling is the only portable way to enforce one
//! without pulling in an async runtime or a signal-handling crate — and this
//! module deliberately adds NO dependency for a feature whose whole job is to
//! shell out.
//!
//! # Why `wait()` after `kill()`, and why that wait is itself bounded
//!
//! `kill()` only delivers the signal; the child stays a zombie until it is
//! reaped. Skipping the `wait()` would leak a process-table entry per timeout,
//! which is exactly the situation (a command that hangs every run) where it
//! would accumulate. An `Err` from `kill()` is ignored: it means the child
//! already exited between the last poll and the kill, which is not a failure.
//!
//! But `wait()` blocks, and SIGKILL is not instantaneous for a process sitting
//! in an uninterruptible syscall (a hung NFS mount, a wedged device): it stays
//! unkillable until that syscall returns, and a blocking `wait` would stall with
//! it — past the deadline, for as long as the kernel takes. The reap therefore
//! happens on its own thread and the parent waits at most [`REAP_GRACE`]. In the
//! rare case that is not enough, the entry lives until the vibe process exits
//! and `init` adopts it; for a CLI that is moments away, and it is strictly
//! better than an unbounded hang.
//!
//! # Why the deadline governs the READS too, not just the child
//!
//! Reaping the child does NOT necessarily close its pipes. `sh -c 'sleep 20 &
//! exit 0'` exits immediately, but the backgrounded grandchild inherited the
//! write end of stdout/stderr, so those pipes stay open and a reader thread
//! blocks until the grandchild finishes. Waiting on such a thread would make
//! the deadline advisory: measured against `sleep 20 & exit 0` with a 1-second
//! timeout, the call blocked for the full 20 seconds and reported
//! `timed_out == false`.
//!
//! The reader threads therefore hand their result back over an
//! [`mpsc`](std::sync::mpsc) channel, and the parent collects with
//! `recv_timeout` bounded by the SAME deadline. A reader that has not finished
//! by then is abandoned (detached, not joined): whatever it had read is given
//! up, the run is reported as timed out, and the thread dies with the process.
//! That makes the deadline a real bound on how long `vibe list` can take,
//! which is the property the timeout was configured for.
//!
//! The writer thread is collected the same way and for the same reason: it
//! normally ends on `EPIPE` once the child is gone, but a grandchild holding
//! the stdin READ end open can keep the write blocked past the deadline.
//!
//! # Reads are bounded at the read, not after it
//!
//! `read_to_end` on a hostile command (`yes`) buffers without limit — measured
//! at 977 MB RSS before the post-hoc size check ever ran. Each stream is read
//! through `Read::take(cap + 1)` instead, exactly as
//! [`read_capped`](crate::stdin::StdinReader::read_capped) does for untrusted
//! stdin: the `+ 1` makes an overflow detectable while capping what is ever
//! held in memory. The stdout limit is the contract's
//! [`MAX_SUMMARY_STDOUT_BYTES`](crate::summary::MAX_SUMMARY_STDOUT_BYTES); the
//! post-read length check stays where it is, because it is what turns "we
//! stopped reading" into the user-visible contract violation.
//!
//! Past the cap the stream is DRAINED, not closed — see
//! [`spawn_capped_reader`]. Closing it would `SIGPIPE` a command whose only
//! sin was being verbose, and the deadline already bounds how long the drain
//! can go on.
//!
//! # Known limitation: grandchildren survive
//!
//! `kill()` signals the shell we spawned, not its descendants. A command that
//! backgrounds work (`cmd &`) keeps running after the timeout — vibe stops
//! waiting for it, but does not stop it. Confining the whole tree would need a
//! process group (`setpgid` + `killpg`), which is unix-only and has no Windows
//! analogue; the escape hatch is documented rather than half-implemented, and
//! this module is the single place a future process-group version would change.

use crate::error::{Result, VibeError};
use crate::summary::MAX_SUMMARY_STDOUT_BYTES;
use std::time::Duration;

/// Largest stderr captured from the summary command.
///
/// Far smaller than the stdout cap because stderr is never the product: at most
/// its first line is quoted back in a warning. 64 KiB is room for a stack trace
/// and nothing like room for a stream.
pub const MAX_SUMMARY_STDERR_BYTES: usize = 64 * 1024;

/// One request to the configured summary command.
pub struct SummaryInvocation<'a> {
    /// The shell command line, verbatim from `[summary] command`.
    pub command: &'a str,
    /// Working directory (the main worktree).
    pub cwd: &'a str,
    /// The JSON batch written to the command's stdin.
    pub stdin_payload: &'a str,
    /// How long the command may run before it is killed.
    pub timeout: Duration,
}

/// Captured result of one summary command run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryOutput {
    /// Exit status, or `-1` when the process was killed / left no code.
    pub code: i32,
    /// The command's stdout, empty when it was not valid UTF-8 (see
    /// [`stdout_invalid_utf8`](Self::stdout_invalid_utf8)).
    pub stdout: String,
    pub stderr: String,
    /// Whether the deadline expired and the process was killed.
    pub timed_out: bool,
    /// Whether stdout contained bytes that are not valid UTF-8.
    ///
    /// A separate flag rather than a sentinel inside `stdout`, because the
    /// obvious sentinel — U+FFFD — is a character a command may legitimately
    /// emit, and the two cases must not be confused. Decoding leniently would
    /// REWRITE the answer: `{"main":"x\xffy"}` becomes valid JSON reading
    /// `{"main":"x\u{fffd}y"}`, and vibe would accept, display and cache a
    /// summary the command never produced. The contract is UTF-8 JSON; bytes
    /// that are not UTF-8 are a violation of it, not something to repair.
    pub stdout_invalid_utf8: bool,
}

/// Runs the `[summary]` command.
pub trait SummaryRunner {
    fn run_summary(&self, invocation: &SummaryInvocation) -> Result<SummaryOutput>;
}

/// Forward through a reference, so a `&dyn SummaryRunner` seam satisfies
/// `impl SummaryRunner` at the generic call sites (same shape as
/// [`HookRunner`](crate::hooks::HookRunner)).
impl<T: SummaryRunner + ?Sized> SummaryRunner for &T {
    fn run_summary(&self, invocation: &SummaryInvocation) -> Result<SummaryOutput> {
        (**self).run_summary(invocation)
    }
}

/// How often the parent checks whether the child has exited.
///
/// 25 ms is short enough that a fast command is not perceptibly delayed by the
/// poll granularity, and long enough that a command running for the full
/// 30-second default costs about 1200 cheap `waitpid` calls rather than a spin.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// How long the parent waits for a killed child to actually be reaped.
///
/// Short and fixed rather than derived from the deadline: by this point the
/// deadline has ALREADY expired, so any further wait is time the user did not
/// ask for. A process that has been SIGKILLed is normally reaped in
/// microseconds; 100 ms covers a loaded machine and stops well short of being
/// noticeable.
const REAP_GRACE: Duration = Duration::from_millis(100);

/// Production [`SummaryRunner`]: `/bin/sh -c <cmd>` (unix) / `cmd /c <cmd>`
/// (Windows), with the payload piped to stdin and a wall-clock deadline.
pub struct RealSummaryRunner;

impl SummaryRunner for RealSummaryRunner {
    fn run_summary(&self, invocation: &SummaryInvocation) -> Result<SummaryOutput> {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let mut command = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.arg("/c").arg(invocation.command);
            c
        } else {
            let mut c = Command::new("/bin/sh");
            c.arg("-c").arg(invocation.command);
            c
        };
        command
            .current_dir(invocation.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let fail = |message: String| VibeError::HookExecution {
            hook_command: invocation.command.to_string(),
            message,
        };

        let deadline = std::time::Instant::now() + invocation.timeout;
        let mut child = command.spawn().map_err(|e| fail(e.to_string()))?;

        // `take` (not a borrow) so each handle moves into its own thread and is
        // dropped there — the child sees EOF on stdin as soon as the payload is
        // written, without the parent having to remember to close anything.
        let mut stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let payload = invocation.stdin_payload.to_string();

        // One channel per stream rather than a join handle: see the module
        // header. A `SyncSender` is not needed — each thread sends exactly once.
        let (writer_done, writer_rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            if let Some(handle) = stdin.as_mut() {
                // A write failure is not reported: the only realistic cause is a
                // command that exits without reading its input (`echo '{}'`),
                // which is legitimate and whose stdout still has to be read.
                let _ = handle.write_all(payload.as_bytes());
                let _ = handle.flush();
            }
            drop(stdin);
            // The receiver is gone if the parent already gave up; ignore that.
            let _ = writer_done.send(());
        });

        let out_rx = spawn_capped_reader(stdout, MAX_SUMMARY_STDOUT_BYTES);
        let err_rx = spawn_capped_reader(stderr, MAX_SUMMARY_STDERR_BYTES);

        let mut timed_out = false;
        let status = loop {
            match child.try_wait().map_err(|e| fail(e.to_string()))? {
                Some(status) => break Some(status),
                None => {
                    if std::time::Instant::now() >= deadline {
                        // Best-effort: an Err here means the child exited in the
                        // window between the poll and the kill.
                        let _ = child.kill();
                        // Reap on a thread, bounded like everything else. A
                        // process that is unkillable for the moment — blocked in
                        // an uninterruptible syscall on a hung NFS mount or a
                        // wedged device — does not respond to SIGKILL until that
                        // syscall returns, and `wait` would block with it,
                        // reintroducing exactly the unbounded stall the deadline
                        // exists to prevent.
                        //
                        // Why not simply skip the reap: a zombie holds a
                        // process-table entry. Handing the child to a thread
                        // keeps the reap happening in the overwhelming majority
                        // of cases while never making the CALLER wait for it. If
                        // even the thread cannot reap, the entry lives until the
                        // vibe process exits — which for a CLI is the next
                        // moment anyway, and at that point `init` adopts and
                        // reaps it.
                        let (reaped, reaped_rx) = std::sync::mpsc::channel();
                        std::thread::spawn(move || {
                            let _ = child.wait();
                            let _ = reaped.send(());
                        });
                        let _ = reaped_rx.recv_timeout(REAP_GRACE);
                        timed_out = true;
                        break None;
                    }
                    std::thread::sleep(POLL_INTERVAL);
                }
            }
        };

        // Collect under the SAME deadline. Reaping the child does not imply its
        // pipes are closed (a grandchild may hold them), so these must not be
        // unbounded joins.
        let (stdout, stdout_late) = collect(&out_rx, deadline);
        let (stderr, stderr_late) = collect(&err_rx, deadline);
        let writer_late = writer_rx.recv_timeout(remaining(deadline)).is_err();
        // Abandoning any stream means the run did not complete within its
        // deadline, whatever the child's own exit status said.
        timed_out = timed_out || stdout_late || stderr_late || writer_late;

        // stdout is PARSED, so it is decoded strictly: see
        // `SummaryOutput::stdout_invalid_utf8`.
        let (stdout, stdout_invalid_utf8) = match String::from_utf8(stdout) {
            Ok(text) => (text, false),
            Err(_) => (String::new(), true),
        };

        Ok(SummaryOutput {
            code: status.and_then(|s| s.code()).unwrap_or(-1),
            stdout,
            // stderr stays LOSSY: nothing is parsed out of it, at most its first
            // line is quoted back in a warning, and a diagnostic that happens to
            // carry a stray byte is still worth showing. Refusing to decode it
            // would discard the only explanation a failing command gave us.
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            timed_out,
            stdout_invalid_utf8,
        })
    }
}

/// Buffer at most `cap + 1` bytes of `handle`, then keep READING and discarding
/// until EOF, on its own thread; the buffered bytes come back over the returned
/// channel.
///
/// `cap + 1` so the caller can still tell "exactly at the cap" from "over it"
/// while never buffering more than one byte beyond the limit.
///
/// # Why the rest is drained rather than left unread
///
/// Stopping at the cap and dropping the handle closes our end of the pipe, and
/// the next write from the command gets `SIGPIPE`/`EPIPE`. That kills a
/// perfectly well-behaved command for being verbose: measured, a `python3` that
/// writes 200 KB of diagnostics to stderr and then prints a valid `{}` exits
/// **120** with its answer lost, and vibe reports "summary command exited with
/// code 120" instead of using the summary it actually produced. The cap exists
/// to bound our MEMORY, not to censor the command mid-sentence.
///
/// Draining costs nothing in the normal case (there is nothing left to read) and
/// is bounded in the abnormal one: an endless stream keeps this thread reading,
/// but the parent collects with `recv_timeout` against the deadline and abandons
/// it, so the run ends as a timeout rather than a hang.
fn spawn_capped_reader<R>(handle: Option<R>, cap: usize) -> std::sync::mpsc::Receiver<Vec<u8>>
where
    R: std::io::Read + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut handle) = handle {
            use std::io::Read;
            // A read error (the pipe died mid-stream) keeps whatever arrived:
            // a partial answer is still worth the contract check.
            let _ = (&mut handle).take(cap as u64 + 1).read_to_end(&mut buf);
            // Over the cap: keep the pipe OPEN and swallow the remainder, so the
            // command can finish saying what it was saying and exit on its own
            // terms. `io::sink` discards without accumulating.
            if buf.len() > cap {
                let _ = std::io::copy(&mut handle, &mut std::io::sink());
            }
        }
        let _ = tx.send(buf);
    });
    rx
}

/// Time left before `deadline`, or zero once it has passed.
///
/// `Duration` cannot be negative, so this is what makes `recv_timeout` safe to
/// call after the child already overran: it degrades to a non-blocking poll.
fn remaining(deadline: std::time::Instant) -> Duration {
    deadline.saturating_duration_since(std::time::Instant::now())
}

/// Take a reader thread's bytes if it finished in time; otherwise abandon it.
///
/// Returns `(bytes, gave_up)`. Giving up yields an empty buffer rather than a
/// partial one: the thread still owns its `Vec` and there is no way to reach
/// into it, and a truncated JSON document would fail the contract check anyway.
fn collect(
    rx: &std::sync::mpsc::Receiver<Vec<u8>>,
    deadline: std::time::Instant,
) -> (Vec<u8>, bool) {
    match rx.recv_timeout(remaining(deadline)) {
        Ok(bytes) => (bytes, false),
        Err(_) => (Vec::new(), true),
    }
}

#[cfg(any(test, feature = "test-util"))]
pub use fake::{FakeSummaryRunner, SummaryCall};

#[cfg(any(test, feature = "test-util"))]
mod fake {
    use super::{SummaryInvocation, SummaryOutput, SummaryRunner};
    use crate::error::Result;
    use std::cell::RefCell;
    use std::time::Duration;

    /// One recorded invocation, flattened so assertions do not need lifetimes.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct SummaryCall {
        pub command: String,
        pub cwd: String,
        pub stdin_payload: String,
        pub timeout: Duration,
    }

    /// Records every [`SummaryCall`] and replays a scripted [`SummaryOutput`].
    ///
    /// Same shape as [`FakeHookRunner`](crate::hooks::FakeHookRunner): a
    /// `RefCell` log the test reads afterwards, and a fixed answer configured up
    /// front. The call log is what proves the cache worked — a full cache hit is
    /// only observable as the ABSENCE of a call.
    pub struct FakeSummaryRunner {
        pub calls: RefCell<Vec<SummaryCall>>,
        response: Result<SummaryOutput>,
    }

    impl FakeSummaryRunner {
        /// Succeeds with `stdout` (the JSON map the orchestrator will parse).
        pub fn with_stdout(stdout: &str) -> Self {
            FakeSummaryRunner {
                calls: RefCell::new(vec![]),
                response: Ok(SummaryOutput {
                    code: 0,
                    stdout: stdout.to_string(),
                    stderr: String::new(),
                    timed_out: false,
                    stdout_invalid_utf8: false,
                }),
            }
        }

        /// Exits non-zero with `stderr` and no usable stdout.
        pub fn failing(code: i32, stderr: &str) -> Self {
            FakeSummaryRunner {
                calls: RefCell::new(vec![]),
                response: Ok(SummaryOutput {
                    code,
                    stdout: String::new(),
                    stderr: stderr.to_string(),
                    timed_out: false,
                    stdout_invalid_utf8: false,
                }),
            }
        }

        /// Hits the deadline and is killed.
        pub fn timing_out() -> Self {
            FakeSummaryRunner {
                calls: RefCell::new(vec![]),
                response: Ok(SummaryOutput {
                    code: -1,
                    stdout: String::new(),
                    stderr: String::new(),
                    timed_out: true,
                    stdout_invalid_utf8: false,
                }),
            }
        }

        /// Exits 0 but its stdout was not valid UTF-8.
        pub fn invalid_utf8_stdout() -> Self {
            FakeSummaryRunner {
                calls: RefCell::new(vec![]),
                response: Ok(SummaryOutput {
                    code: 0,
                    // Empty, exactly as the real runner leaves it: the bytes are
                    // not representable as a `String`, and inventing a lossy
                    // stand-in here would hide the very bug this models.
                    stdout: String::new(),
                    stderr: String::new(),
                    timed_out: false,
                    stdout_invalid_utf8: true,
                }),
            }
        }

        /// The command could not be spawned at all.
        pub fn spawn_error(message: &str) -> Self {
            FakeSummaryRunner {
                calls: RefCell::new(vec![]),
                response: Err(crate::error::VibeError::HookExecution {
                    hook_command: "summary".to_string(),
                    message: message.to_string(),
                }),
            }
        }

        pub fn calls(&self) -> Vec<SummaryCall> {
            self.calls.borrow().clone()
        }
    }

    impl SummaryRunner for FakeSummaryRunner {
        fn run_summary(&self, invocation: &SummaryInvocation) -> Result<SummaryOutput> {
            self.calls.borrow_mut().push(SummaryCall {
                command: invocation.command.to_string(),
                cwd: invocation.cwd.to_string(),
                stdin_payload: invocation.stdin_payload.to_string(),
                timeout: invocation.timeout,
            });
            match &self.response {
                Ok(out) => Ok(out.clone()),
                Err(e) => Err(crate::error::VibeError::HookExecution {
                    hook_command: "summary".to_string(),
                    message: e.to_string(),
                }),
            }
        }
    }
}

#[cfg(all(test, unix))]
mod real_tests {
    use super::*;

    fn run(command: &str, payload: &str, timeout_secs: u64) -> SummaryOutput {
        RealSummaryRunner
            .run_summary(&SummaryInvocation {
                command,
                cwd: ".",
                stdin_payload: payload,
                timeout: Duration::from_secs(timeout_secs),
            })
            .unwrap()
    }

    /// What it guarantees: the happy path — stdout is captured verbatim and the
    /// exit code reaches the caller.
    #[test]
    fn captures_stdout_and_exit_code() {
        let out = run("echo '{\"a\":\"b\"}'", "", 10);
        assert_eq!(out.code, 0);
        assert_eq!(out.stdout.trim(), "{\"a\":\"b\"}");
        assert!(!out.timed_out);
    }

    /// What it guarantees: the payload actually reaches the command's stdin, and
    /// a command that both reads its input and writes a large answer does not
    /// deadlock against the pipe buffers.
    #[test]
    fn pipes_the_payload_to_stdin_and_reads_a_large_reply() {
        // `cat` echoes stdin back, then a filler far larger than a 64 KiB pipe
        // buffer is appended — the exact shape that deadlocks a
        // write-then-read implementation.
        let out = run(
            "cat; head -c 200000 /dev/zero | tr '\\0' 'x'",
            "hello-stdin",
            20,
        );
        assert!(
            out.stdout.starts_with("hello-stdin"),
            "got: {}",
            &out.stdout[..40.min(out.stdout.len())]
        );
        assert_eq!(out.stdout.len(), "hello-stdin".len() + 200_000);
    }

    /// What it guarantees: a command that never exits is killed at the deadline
    /// and reported as timed out rather than hanging `vibe list` forever.
    #[test]
    fn kills_a_command_that_outruns_its_deadline() {
        let started = std::time::Instant::now();
        let out = run("sleep 60", "", 1);
        assert!(out.timed_out);
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "the deadline was not enforced"
        );
    }

    /// What it guarantees: stderr is captured separately, so a chatty command
    /// cannot corrupt the JSON we parse from stdout.
    #[test]
    fn captures_stderr_without_mixing_it_into_stdout() {
        let out = run("echo noise >&2; echo '{}'", "", 10);
        assert_eq!(out.stdout.trim(), "{}");
        assert!(out.stderr.contains("noise"));
    }

    /// What it guarantees: a command that exits without draining stdin (very
    /// common — `echo` ignores its input) still succeeds; the writer's EPIPE is
    /// not an error.
    #[test]
    fn a_command_that_ignores_stdin_still_succeeds() {
        let big = "x".repeat(200_000);
        let out = run("echo '{}'", &big, 10);
        assert_eq!(out.code, 0);
        assert_eq!(out.stdout.trim(), "{}");
    }

    /// What it guarantees: an endless stdout stream is bounded AT THE READ, so a
    /// hostile command cannot exhaust memory before the contract check runs.
    ///
    /// The assertion is on the buffer LENGTH, not on the eventual warning: the
    /// post-read size check would report the violation either way, and only the
    /// length proves nothing larger was ever held.
    #[test]
    fn an_endless_stdout_stream_is_capped_while_reading() {
        // `yes` prints forever; `head -c` bounds the TEST's runtime, not the
        // implementation's memory (the cap has to do that).
        let out = run(
            &format!("yes x | head -c {}", MAX_SUMMARY_STDOUT_BYTES * 4),
            "",
            30,
        );
        assert_eq!(
            out.stdout.len(),
            MAX_SUMMARY_STDOUT_BYTES + 1,
            "stdout must stop at the cap plus the one overflow-detection byte"
        );
        // And the parser still calls it a violation, so the user sees why.
        assert!(crate::summary::parse_summary_stdout(&out.stdout, 1).is_err());
    }

    /// What it guarantees: stderr is capped too. It is never the product — only
    /// its first line is ever quoted — so an endless stderr must not be buffered.
    #[test]
    fn an_endless_stderr_stream_is_capped_while_reading() {
        let out = run(
            &format!(
                "yes e | head -c {} >&2; echo '{{}}'",
                MAX_SUMMARY_STDERR_BYTES * 4
            ),
            "",
            30,
        );
        assert_eq!(out.stderr.len(), MAX_SUMMARY_STDERR_BYTES + 1);
        // The command still succeeded, and its stdout is intact.
        assert_eq!(out.stdout.trim(), "{}");
    }

    /// What it guarantees: a command that writes MORE than the stderr cap and
    /// then answers correctly is still treated as a success.
    ///
    /// Closing the read end at the cap sends SIGPIPE (or an EPIPE write error)
    /// to a perfectly well-behaved command that happened to be chatty — Python
    /// dies with exit 120 — turning "the diagnostics were long" into "the
    /// summary command failed", which discards a valid answer and warns.
    #[test]
    fn a_chatty_but_successful_command_is_not_killed_by_the_stderr_cap() {
        let out = run(
            &format!(
                "yes e | head -c {} >&2; echo '{{}}'",
                MAX_SUMMARY_STDERR_BYTES * 4
            ),
            "",
            30,
        );
        assert_eq!(out.code, 0, "a chatty command must not be failed");
        assert!(!out.timed_out);
        assert_eq!(out.stdout.trim(), "{}", "its answer must survive");
        assert_eq!(
            out.stderr.len(),
            MAX_SUMMARY_STDERR_BYTES + 1,
            "stderr is still capped in memory"
        );
    }

    /// The same shape with a real interpreter, which is what surfaces the
    /// SIGPIPE: `yes | head` can mask it, but Python reports exit 120 when its
    /// stderr flush fails at interpreter shutdown.
    #[test]
    fn a_python_command_writing_past_the_stderr_cap_still_succeeds() {
        let out = run(
            "python3 -c 'import sys; sys.stderr.write(\"x\" * 200000); print(\"{}\")'",
            "",
            30,
        );
        assert_eq!(
            out.code, 0,
            "python must not die on a broken stderr pipe: {out:?}"
        );
        assert_eq!(out.stdout.trim(), "{}");
    }

    /// (b) What it guarantees: an over-cap STDOUT is still rejected, and the
    /// failure mode is the stable "too large" one rather than a killed command.
    ///
    /// The drain matters here too: without it the command dies on a broken
    /// stdout pipe and the run reports a non-zero exit, so the same input
    /// produces "exited with code N" or "produced more than N bytes" depending
    /// on how fast it wrote. Draining pins it to the contract violation.
    #[test]
    fn an_over_cap_stdout_is_rejected_not_killed() {
        let out = run(
            &format!(
                "python3 -c 'import sys; sys.stdout.write(\"x\" * {})'",
                MAX_SUMMARY_STDOUT_BYTES * 2
            ),
            "",
            30,
        );
        assert_eq!(
            out.code, 0,
            "the command must exit on its own terms: {out:?}"
        );
        assert_eq!(
            out.stdout.len(),
            MAX_SUMMARY_STDOUT_BYTES + 1,
            "only the cap plus the overflow byte is buffered"
        );
        // And the parser turns that into the documented violation.
        let err = crate::summary::parse_summary_stdout(&out.stdout, 1).unwrap_err();
        assert!(err.contains("bytes"), "got: {err}");
    }

    /// What it guarantees: stdout that is not valid UTF-8 is REPORTED as such,
    /// not silently repaired into something that parses.
    ///
    /// `from_utf8_lossy` would turn `{"main":"x\xffy"}` into valid JSON reading
    /// `{"main":"x\u{fffd}y"}` — a summary the command never produced, which
    /// vibe would then display and cache as if it had.
    #[test]
    fn invalid_utf8_on_stdout_is_flagged_rather_than_repaired() {
        // A lone 0xff byte inside an otherwise well-formed JSON document.
        let out = run(r#"printf '{"main":"x\377y"}'"#, "", 10);
        assert_eq!(out.code, 0, "the command itself succeeded: {out:?}");
        assert!(
            out.stdout_invalid_utf8,
            "the undecodable bytes must be reported: {out:?}"
        );
        assert!(
            out.stdout.is_empty(),
            "no repaired stand-in may be handed on: {:?}",
            out.stdout
        );
    }

    /// The complement: a summary that legitimately CONTAINS U+FFFD is valid
    /// UTF-8 and must pass through untouched, which is why the failure needs a
    /// flag of its own rather than sniffing for the replacement character.
    #[test]
    fn a_genuine_replacement_character_is_not_mistaken_for_invalid_utf8() {
        let out = run(r#"printf '{"main":"x\357\277\275y"}'"#, "", 10);
        assert!(!out.stdout_invalid_utf8, "got: {out:?}");
        assert_eq!(out.stdout, "{\"main\":\"x\u{fffd}y\"}");
        // And it parses, so such a summary is usable.
        assert!(crate::summary::parse_summary_stdout(&out.stdout, 1).is_ok());
    }

    /// What it guarantees: the deadline bounds the CALL, not merely the child.
    ///
    /// `sleep 20 & exit 0` makes the shell exit at once while a grandchild keeps
    /// the inherited stdout/stderr write ends open. Joining the reader threads
    /// here blocked for the grandchild's full 20 seconds and reported
    /// `timed_out == false`, which made the configured timeout advisory.
    #[test]
    fn a_grandchild_holding_the_pipes_open_cannot_outlast_the_deadline() {
        let started = std::time::Instant::now();
        let out = run("sleep 20 & exit 0", "", 1);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the deadline did not bound the call: {:?}",
            started.elapsed()
        );
        assert!(
            out.timed_out,
            "abandoning a stream must be reported as a timeout"
        );
    }
}
