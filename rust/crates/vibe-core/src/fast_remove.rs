//! Fast worktree removal: move to trash / temp then background-delete.
//!
//! Ported from `packages/core/src/utils/fast-remove.ts`. Strategy (in order):
//! 1. Native system trash (vibe-native `move_to_trash`).
//! 2. Rename into `/tmp` as `.vibe-trash-<now_ms>-<token>` + `spawn_detached`
//!    a background `rm -rf`.
//! 3. On a cross-device (EXDEV) rename failure, fall back to the parent dir.
//!
//! SECURITY (point #2): the background delete uses a FIXED raw-string `sh`
//! script and passes the path as a SEPARATE positional arg `$1` — it is NEVER
//! `format!`-interpolated into the script, so a hostile path cannot inject shell.
//! The macOS osascript fallback rejects control chars and escapes `\`→`\\` then
//! `"`→`\"` (in that order).

use crate::clock::{Clock, RandomSource};
use crate::copy::native::NativeClone;
use crate::io::Io;
use crate::output::verbose_log;
use crate::output::OutputOptions;
use std::path::Path;

/// Spawns a detached background process (does NOT wait for it).
pub trait BackgroundSpawner {
    /// Spawn `argv[0]` with `argv[1..]` as args, detached, ignoring its output.
    /// `argv` is a fully-formed argument vector — NO shell parsing of a string.
    fn spawn_detached(&self, argv: &[&str]);
}

/// Forward through a reference so `&dyn BackgroundSpawner` satisfies the trait.
impl<T: BackgroundSpawner + ?Sized> BackgroundSpawner for &T {
    fn spawn_detached(&self, argv: &[&str]) {
        (**self).spawn_detached(argv)
    }
}

/// Production [`BackgroundSpawner`].
pub struct RealBackgroundSpawner;

impl BackgroundSpawner for RealBackgroundSpawner {
    fn spawn_detached(&self, argv: &[&str]) {
        let Some((cmd, args)) = argv.split_first() else {
            return;
        };
        let mut command = std::process::Command::new(cmd);
        command
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        // Spawn and DROP the child (do not wait). On Unix the `sh -c '... &'`
        // script backgrounds the actual `rm` and returns immediately.
        let _ = command.spawn();
    }
}

/// Result of [`fast_remove_directory`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoveResult {
    pub success: bool,
    /// Where the directory was moved (system trash display path or the temp path).
    pub trashed_path: Option<String>,
    pub error: Option<String>,
}

impl RemoveResult {
    fn ok(trashed: Option<String>) -> Self {
        RemoveResult {
            success: true,
            trashed_path: trashed,
            error: None,
        }
    }
    fn fail(error: String) -> Self {
        RemoveResult {
            success: false,
            trashed_path: None,
            error: Some(error),
        }
    }
}

/// Display path for the system Trash returned to callers (TS parity).
pub const SYSTEM_TRASH_DISPLAY_PATH: &str = "~/.Trash";

/// Whether fast remove is supported on this platform (always true; kept for API
/// stability, matching the TS).
pub fn is_fast_remove_supported() -> bool {
    true
}

/// The fixed `sh -c` background-delete script. The path is `$1` (a positional
/// arg), so it is NEVER interpolated into this string (security point #2).
#[cfg(not(windows))]
const NOHUP_RM_SCRIPT: &str = r#"nohup rm -rf "$1" >/dev/null 2>&1 &"#;

/// Build the argv for a background delete of `path` (exposed for testing the
/// EXACT argv shape — the `$1` positional, never an interpolated path).
pub fn background_delete_argv(path: &str) -> Vec<String> {
    if cfg!(windows) {
        // `path` is passed as its OWN argv element to `cmd /c rmdir`, not spliced
        // into a shell command string, so it is never re-parsed by a shell — no
        // fixed-script `$1`-style wrapper is needed here (unlike the Unix branch).
        vec![
            "cmd".into(),
            "/c".into(),
            "rmdir".into(),
            "/s".into(),
            "/q".into(),
            path.into(),
        ]
    } else {
        // sh -c '<fixed script>' _ <path>  — `_` is $0, `<path>` is $1.
        vec![
            "sh".into(),
            "-c".into(),
            NOHUP_RM_SCRIPT.into(),
            "_".into(),
            path.into(),
        ]
    }
}

/// Spawn the background delete for `path` using the fixed-script argv.
fn spawn_background_delete(spawner: &impl BackgroundSpawner, path: &str) {
    let argv = background_delete_argv(path);
    let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    spawner.spawn_detached(&refs);
}

/// The system temp directory (`/tmp` on unix; `%TEMP%`/`%TMP%` on Windows).
fn temp_dir(io: &impl Io) -> String {
    if cfg!(windows) {
        io.env("TEMP")
            .or_else(|| io.env("TMP"))
            .unwrap_or_else(|| "C:\\Windows\\Temp".to_string())
    } else {
        "/tmp".to_string()
    }
}

/// Generate the unique trash dir name `.vibe-trash-<now_ms>-<token>`.
fn trash_name(clock: &impl Clock, random: &impl RandomSource) -> String {
    format!(".vibe-trash-{}-{}", clock.now_ms(), random.token())
}

/// Move `target` to system trash, returning whether it succeeded.
///
/// Tries native trash first (vibe-native); on macOS, if native fails, falls back
/// to osascript Finder delete. On Linux/other, a native failure returns false so
/// the caller uses the `/tmp` fallback.
fn move_to_system_trash(
    io: &impl Io,
    native: &impl NativeClone,
    target: &str,
    opts: OutputOptions,
) -> bool {
    if native.is_available() {
        match native.move_to_trash(Path::new(target)) {
            Ok(()) => return true,
            Err(e) => verbose_log(io, &format!("Native trash failed: {e}"), opts),
        }
    }

    if native.get_platform() == "darwin" {
        return move_to_macos_trash_via_osascript(target);
    }

    false
}

/// macOS Finder-trash fallback via `osascript` (security-hardened).
fn move_to_macos_trash_via_osascript(target: &str) -> bool {
    // Reject control characters (injection / AppleScript breakage).
    if target.chars().any(|c| c.is_control()) {
        return false;
    }
    // Escape `\` → `\\` FIRST, then `"` → `\"` (order matters).
    let escaped = target.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(r#"tell application "Finder" to delete POSIX file "{escaped}""#);
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Fast-remove `target`: trash → `/tmp`-rename+background-delete → parent-dir
/// EXDEV fallback. Returns a [`RemoveResult`]; a non-existent target is success
/// (idempotent).
pub fn fast_remove_directory(
    io: &impl Io,
    native: &impl NativeClone,
    spawner: &impl BackgroundSpawner,
    clock: &impl Clock,
    random: &impl RandomSource,
    target: &str,
    opts: OutputOptions,
) -> RemoveResult {
    // Idempotent: missing target → success.
    if !Path::new(target).exists() {
        return RemoveResult::ok(None);
    }

    // 1. System trash.
    if move_to_system_trash(io, native, target, opts) {
        return RemoveResult::ok(Some(SYSTEM_TRASH_DISPLAY_PATH.to_string()));
    }

    // 2. Rename into the system temp dir + background delete.
    let name = trash_name(clock, random);
    let temp = temp_dir(io);
    let temp_trash = Path::new(&temp).join(&name);

    match std::fs::rename(target, &temp_trash) {
        Ok(()) => {
            let temp_trash_str = temp_trash.to_string_lossy().into_owned();
            spawn_background_delete(spawner, &temp_trash_str);
            return RemoveResult::ok(Some(temp_trash_str));
        }
        Err(e) => {
            // Only a cross-device error falls through to the parent-dir fallback;
            // any other error is fatal.
            let is_cross_device = is_exdev(&e);
            if !is_cross_device {
                // NotFound mid-flight = another process removed it → success.
                if e.kind() == std::io::ErrorKind::NotFound {
                    return RemoveResult::ok(None);
                }
                return RemoveResult::fail(e.to_string());
            }
        }
    }

    // 3. Parent-dir fallback (same filesystem).
    let parent = Path::new(target)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| Path::new(".").to_path_buf());
    let fallback = parent.join(&name);
    match std::fs::rename(target, &fallback) {
        Ok(()) => {
            let fallback_str = fallback.to_string_lossy().into_owned();
            spawn_background_delete(spawner, &fallback_str);
            RemoveResult::ok(Some(fallback_str))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => RemoveResult::ok(None),
        Err(e) => RemoveResult::fail(e.to_string()),
    }
}

/// Whether an io error is a cross-device link (EXDEV).
fn is_exdev(e: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        if e.raw_os_error() == Some(libc::EXDEV) {
            return true;
        }
    }
    let msg = e.to_string();
    msg.contains("cross-device") || msg.contains("EXDEV")
}

/// Background-delete every `.vibe-trash-*` directory found under `parent_dir`
/// AND the system temp dir (best effort; errors ignored). Matches the TS
/// `cleanupStaleTrash`.
pub fn cleanup_stale_trash(io: &impl Io, spawner: &impl BackgroundSpawner, parent_dir: &str) {
    cleanup_trash_in_dir(spawner, parent_dir);
    cleanup_trash_in_dir(spawner, &temp_dir(io));
}

fn cleanup_trash_in_dir(spawner: &impl BackgroundSpawner, dir: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let is_vibe_trash = name.starts_with(".vibe-trash-")
            && entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_vibe_trash {
            let path = entry.path();
            spawn_background_delete(spawner, &path.to_string_lossy());
        }
    }
}

#[cfg(any(test, feature = "test-util"))]
pub use fake::FakeBackgroundSpawner;

#[cfg(any(test, feature = "test-util"))]
mod fake {
    use super::BackgroundSpawner;
    use std::cell::RefCell;

    /// Records every spawned argv (so the `$1`-positional shape can be asserted).
    #[derive(Default)]
    pub struct FakeBackgroundSpawner {
        pub spawns: RefCell<Vec<Vec<String>>>,
    }

    impl FakeBackgroundSpawner {
        pub fn new() -> Self {
            FakeBackgroundSpawner::default()
        }
    }

    impl BackgroundSpawner for FakeBackgroundSpawner {
        fn spawn_detached(&self, argv: &[&str]) {
            self.spawns
                .borrow_mut()
                .push(argv.iter().map(|s| s.to_string()).collect());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::{FakeClock, FakeRandom};
    use crate::copy::native::FakeNative;
    use crate::io::FakeIo;
    use crate::timestamp::LocalTime;
    use vibe_test_support::Fixture;

    fn lt() -> LocalTime {
        LocalTime {
            year: 2026,
            month: 6,
            day: 6,
            hour: 0,
            minute: 0,
            second: 0,
        }
    }

    // --- SECURITY #2: background-delete argv shape ($1 positional) ---

    #[cfg(not(windows))]
    #[test]
    fn background_delete_passes_path_as_positional_arg_not_interpolated() {
        let path = "/tmp/.vibe-trash-1-abcd; rm -rf /"; // hostile path
        let argv = background_delete_argv(path);
        // The script is the FIXED literal; the path is a SEPARATE final arg.
        assert_eq!(argv[0], "sh");
        assert_eq!(argv[1], "-c");
        assert_eq!(argv[2], r#"nohup rm -rf "$1" >/dev/null 2>&1 &"#);
        assert_eq!(argv[3], "_"); // $0
        assert_eq!(argv[4], path); // $1, verbatim — NOT interpolated into [2].
                                   // The hostile content never appears inside the script string.
        assert!(!argv[2].contains("rm -rf /"));
    }

    #[test]
    fn native_trash_used_when_available() {
        let fx = Fixture::new();
        let target = fx.mkdir("wt");
        let io = FakeIo::new();
        let native = FakeNative::linux(); // available, move_to_trash records.
        let spawner = FakeBackgroundSpawner::new();
        let clock = FakeClock::new(1000, lt());
        let random = FakeRandom::fixed("abcd1234");

        let res = fast_remove_directory(
            &io,
            &native,
            &spawner,
            &clock,
            &random,
            target.to_str().unwrap(),
            OutputOptions::default(),
        );
        assert!(res.success);
        assert_eq!(res.trashed_path.as_deref(), Some(SYSTEM_TRASH_DISPLAY_PATH));
        // It went through the native trash, not the temp-rename + spawn path.
        assert_eq!(native.trash_calls.borrow().len(), 1);
        assert!(spawner.spawns.borrow().is_empty());
    }

    #[test]
    fn falls_back_to_temp_rename_and_spawns_background_delete() {
        // Native unavailable AND not macOS → /tmp fallback. We rename within the
        // fixture (same filesystem) by pointing temp_dir at it: use a target that
        // renames successfully into the parent fallback path.
        let fx = Fixture::new();
        let target = fx.mkdir("wt");
        let io = FakeIo::new();
        // Unavailable native, platform "unsupported" → not darwin → no osascript.
        let native = FakeNative::unavailable();
        let spawner = FakeBackgroundSpawner::new();
        let clock = FakeClock::new(42, lt());
        let random = FakeRandom::fixed("deadbeef");

        let res = fast_remove_directory(
            &io,
            &native,
            &spawner,
            &clock,
            &random,
            target.to_str().unwrap(),
            OutputOptions::default(),
        );
        assert!(res.success, "remove should succeed: {res:?}");
        // A background delete was spawned with the `$1`-positional shape.
        let spawns = spawner.spawns.borrow();
        assert_eq!(spawns.len(), 1);
        let argv = &spawns[0];
        #[cfg(not(windows))]
        {
            assert_eq!(argv[0], "sh");
            assert_eq!(argv[2], r#"nohup rm -rf "$1" >/dev/null 2>&1 &"#);
            // The trash name carries the injected clock + token.
            assert!(argv[4].contains(".vibe-trash-42-deadbeef"));
        }
        // The original target was moved away.
        assert!(!target.exists());
    }

    #[test]
    fn missing_target_is_idempotent_success() {
        let io = FakeIo::new();
        let native = FakeNative::unavailable();
        let spawner = FakeBackgroundSpawner::new();
        let clock = FakeClock::new(1, lt());
        let random = FakeRandom::fixed("x");
        let res = fast_remove_directory(
            &io,
            &native,
            &spawner,
            &clock,
            &random,
            "/nonexistent/path/xyz",
            OutputOptions::default(),
        );
        assert!(res.success);
        assert_eq!(res.trashed_path, None);
        assert!(spawner.spawns.borrow().is_empty());
    }

    #[test]
    fn cleanup_stale_trash_spawns_for_each_vibe_trash_dir() {
        let fx = Fixture::new();
        fx.mkdir(".vibe-trash-1-aaaa");
        fx.mkdir(".vibe-trash-2-bbbb");
        fx.mkdir("not-trash");
        let io = FakeIo::new();
        let spawner = FakeBackgroundSpawner::new();
        cleanup_stale_trash(&io, &spawner, fx.path().to_str().unwrap());
        // The two trash dirs UNDER THE FIXTURE are spawned (the non-trash dir is
        // ignored). We filter by the fixture path because cleanup_stale_trash
        // also scans the system temp dir, which may hold unrelated leftovers.
        let root = fx.path().to_string_lossy().into_owned();
        let from_fixture = spawner
            .spawns
            .borrow()
            .iter()
            .filter(|argv| argv.last().map(|p| p.starts_with(&root)).unwrap_or(false))
            .count();
        assert_eq!(from_fixture, 2);
    }

    #[test]
    fn osascript_path_rejects_control_chars() {
        assert!(!move_to_macos_trash_via_osascript("/tmp/a\nb"));
        assert!(!move_to_macos_trash_via_osascript("/tmp/a\u{0}b"));
    }

    // --- G-17: is_fast_remove_supported entry decision ---

    #[test]
    fn is_fast_remove_supported_is_always_true() {
        // The TS kept this as an always-true capability gate (API stability); the
        // Rust port mirrors that. There is intentionally NO false branch to drive
        // here — the clean entry decision uses it together with the per-run
        // `settings.clean.fast_remove` toggle (the actual fast-vs-traditional
        // switch is exercised by clean_tests' fast_remove_disabled_* test). This
        // locks the contract so a future change that makes it conditional is caught.
        assert!(is_fast_remove_supported());
    }
}
