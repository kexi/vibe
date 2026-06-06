//! Injected side-effects: stderr/stdin, the environment and `$HOME`.
//!
//! The TypeScript code reached the outside world through an `AppContext`
//! (`ctx.runtime.{io,env,...}`) so commands were testable with a fake runtime.
//! This trait plays the same role for the Rust port: every command takes an
//! `&impl Io` instead of touching `std::env`/`std::io` directly, so tests drive
//! them with a scripted stdin and a fixed env map (see [`FakeIo`] in tests).
//!
//! Why a trait rather than passing closures: the command surface needs several
//! related capabilities (writeln, read line, tty detection, env lookups) and a
//! single object groups them, matching the `runtime` object the TS threaded.

use std::io::{IsTerminal, Write};

/// Abstraction over stderr, stdin and the process environment.
pub trait Io {
    /// Write a line (message + `\n`) to stderr. Errors are swallowed, matching
    /// the TS `console.error` which never surfaces write failures to callers.
    fn writeln_stderr(&self, message: &str);

    /// Read one line from stdin, trimmed. `None` on EOF / no data, mirroring the
    /// TS `readLine` returning `null`.
    fn read_line(&self) -> Option<String>;

    /// Whether stderr is a terminal (drives color + interactivity defaults).
    fn is_stderr_terminal(&self) -> bool;

    /// Whether stdin is a terminal.
    fn is_stdin_terminal(&self) -> bool;

    /// Look up an environment variable.
    fn env(&self, key: &str) -> Option<String>;

    /// The user's home directory (`$HOME`), if any.
    fn home(&self) -> Option<String> {
        self.env("HOME")
    }

    /// Whether interactive prompts are forced on (`VIBE_FORCE_INTERACTIVE=1`).
    ///
    /// Needed for the e2e PTY tests: node-pty's stdin is not always recognized
    /// as a TTY, so this flag forces interactive behavior. Same semantics as
    /// the TS `runtime.env.get("VIBE_FORCE_INTERACTIVE") === "1"`.
    fn force_interactive(&self) -> bool {
        self.env("VIBE_FORCE_INTERACTIVE").as_deref() == Some("1")
    }
}

/// Production [`Io`] over the real process stderr/stdin and environment.
pub struct RealIo;

impl Io for RealIo {
    fn writeln_stderr(&self, message: &str) {
        // Why writeln to a locked handle rather than `eprintln!`: prompts in the
        // TS used `writeSync` to bypass buffering in PTYs; a single locked write
        // keeps the message + newline atomic for the same reason.
        let stderr = std::io::stderr();
        let mut handle = stderr.lock();
        let _ = writeln!(handle, "{message}");
    }

    fn read_line(&self) -> Option<String> {
        let mut line = String::new();
        let n = std::io::stdin().read_line(&mut line).ok()?;
        if n == 0 {
            return None; // EOF.
        }
        Some(line.trim().to_string())
    }

    fn is_stderr_terminal(&self) -> bool {
        std::io::stderr().is_terminal()
    }

    fn is_stdin_terminal(&self) -> bool {
        std::io::stdin().is_terminal()
    }

    fn env(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

#[cfg(any(test, feature = "test-util"))]
pub use fake::FakeIo;

#[cfg(any(test, feature = "test-util"))]
mod fake {
    use super::Io;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::collections::VecDeque;

    /// A scriptable [`Io`] for tests: a stdin line queue, an env map, captured
    /// stderr lines and configurable tty flags.
    #[derive(Default)]
    pub struct FakeIo {
        env: HashMap<String, String>,
        stdin: RefCell<VecDeque<String>>,
        pub stderr: RefCell<Vec<String>>,
        stderr_tty: bool,
        stdin_tty: bool,
    }

    impl FakeIo {
        pub fn new() -> Self {
            FakeIo::default()
        }

        pub fn with_env(mut self, key: &str, value: &str) -> Self {
            self.env.insert(key.to_string(), value.to_string());
            self
        }

        /// Queue stdin lines, consumed in order by `read_line`.
        pub fn with_stdin(self, lines: &[&str]) -> Self {
            *self.stdin.borrow_mut() = lines.iter().map(|s| s.to_string()).collect();
            self
        }

        pub fn stderr_tty(mut self, yes: bool) -> Self {
            self.stderr_tty = yes;
            self
        }

        pub fn stdin_tty(mut self, yes: bool) -> Self {
            self.stdin_tty = yes;
            self
        }

        /// All stderr lines joined with `\n` for easy assertions.
        pub fn stderr_text(&self) -> String {
            self.stderr.borrow().join("\n")
        }
    }

    impl Io for FakeIo {
        fn writeln_stderr(&self, message: &str) {
            self.stderr.borrow_mut().push(message.to_string());
        }

        fn read_line(&self) -> Option<String> {
            self.stdin.borrow_mut().pop_front()
        }

        fn is_stderr_terminal(&self) -> bool {
            self.stderr_tty
        }

        fn is_stdin_terminal(&self) -> bool {
            self.stdin_tty
        }

        fn env(&self, key: &str) -> Option<String> {
            self.env.get(key).cloned()
        }
    }
}
