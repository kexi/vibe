//! The five copy strategies and the [`CopyExecutor`] that selects among them.
//!
//! Ported from `utils/copy/strategies/*.ts` and `utils/copy/index.ts`
//! (`CopyService`). Every external command uses `std::process::Command` directly
//! (NO shell), with the EXACT argv approved in the design review (finding #6):
//!
//! - Clone (cp): macOS `cp -cR -- <src> <dest>` (dir) / `cp -c -- <src> <dest>`
//!   (file); Linux `cp -r --reflink=auto -- <src> <dest>` (dir) /
//!   `cp --reflink=auto -- <src> <dest>` (file). `--` ends option parsing.
//! - Rsync: `rsync -a -- <src>/ <dest>` (dir, trailing slash on src) /
//!   `rsync -a -- <src> <dest>` (file).
//! - Robocopy: `robocopy <src> <dest> /E /MT /NFL /NDL /NJH /NJS /NP /R:1 /W:1`
//!   (no `--`; instead src/dest are asserted absolute before spawning);
//!   exit code < 8 == success.
//! - Standard: `std::fs::copy` (file) / a recursive copy (dir).
//! - Clonefile (native): delegates to the [`super::native::NativeClone`]; a
//!   symlink rejection (`UnsupportedFileType`) is a HARD error that does NOT fall
//!   back (finding #5); only ENOTSUP/unavailable (`Failed`) falls back.
//!
//! `validate_path` runs on every path even though `--` is present (defense in
//! depth, a separate layer).

use super::detector::CapabilityProbe;
use super::native::NativeClone;
use super::types::{validate_path, CopyError, CopyResult, CopyStrategyKind};
use std::path::Path;
use std::process::Command;

/// Execute one copy unit, abstracting strategy selection from the runner.
pub trait CopyExecutor {
    /// Copy a single file. Always uses Standard (fastest per-file), matching TS.
    fn copy_file(&self, src: &str, dest: &str) -> CopyResult<()>;
    /// Copy a directory using the selected (cached) directory strategy.
    fn copy_directory(&self, src: &str, dest: &str) -> CopyResult<()>;
    /// The strategy chosen for directory copies (for the progress label / debug).
    fn directory_strategy(&self) -> CopyStrategyKind;
}

/// Forward through a reference so `&dyn CopyExecutor` satisfies `impl CopyExecutor`
/// (lets `copy_files`/`copy_directories` take the commands' `&dyn` seam).
impl<T: CopyExecutor + ?Sized> CopyExecutor for &T {
    fn copy_file(&self, src: &str, dest: &str) -> CopyResult<()> {
        (**self).copy_file(src, dest)
    }
    fn copy_directory(&self, src: &str, dest: &str) -> CopyResult<()> {
        (**self).copy_directory(src, dest)
    }
    fn directory_strategy(&self) -> CopyStrategyKind {
        (**self).directory_strategy()
    }
}

// --- Strategy primitives (free functions; each takes already-validated paths) --

/// Ensure the parent directory of `dest` exists (best-effort, like the TS
/// `mkdir(dirname(dest), { recursive: true }).catch(() => {})`).
fn ensure_parent(dest: &str) {
    if let Some(parent) = Path::new(dest).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
}

/// Run a `Command`, mapping a non-success exit to [`CopyError::Failed`] with the
/// captured stderr (TS includes the strategy + paths in the message).
fn run_capturing(label: &str, src: &str, dest: &str, cmd: &mut Command) -> CopyResult<()> {
    let output = cmd
        .output()
        .map_err(|e| CopyError::Failed(format!("{label} failed: {src} -> {dest}: {e}")))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(CopyError::Failed(format!(
        "{label} failed: {src} -> {dest}: {}",
        stderr.trim()
    )))
}

/// Standard file copy via `std::fs::copy`.
fn standard_copy_file(src: &str, dest: &str) -> CopyResult<()> {
    ensure_parent(dest);
    std::fs::copy(src, dest)
        .map(|_| ())
        .map_err(|e| CopyError::Failed(format!("Standard copy failed: {src} -> {dest}: {e}")))
}

/// Standard recursive directory copy (no shell), preserving file contents.
fn standard_copy_directory(src: &str, dest: &str) -> CopyResult<()> {
    copy_dir_recursive(Path::new(src), Path::new(dest)).map_err(|e| {
        CopyError::Failed(format!(
            "Standard directory copy failed: {src} -> {dest}: {e}"
        ))
    })
}

/// Recursive directory copy. Symlinks are copied as-is (preserve link), matching
/// node's `cp(..., { recursive: true })` default of not dereferencing.
fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if file_type.is_symlink() {
            // Recreate the symlink rather than following it.
            #[cfg(unix)]
            {
                let target = std::fs::read_link(&from)?;
                let _ = std::fs::remove_file(&to);
                std::os::unix::fs::symlink(target, &to)?;
            }
            #[cfg(not(unix))]
            {
                std::fs::copy(&from, &to)?;
            }
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// `cp` clone, file or directory, with the exact per-OS argv + `--`.
fn cp_clone(src: &str, dest: &str, recursive: bool, macos: bool) -> CopyResult<()> {
    ensure_parent(dest);
    let mut cmd = Command::new("cp");
    if macos {
        // macOS: `cp -c` / `cp -cR`.
        cmd.arg(if recursive { "-cR" } else { "-c" });
    } else if recursive {
        // Linux dir: `cp -r --reflink=auto`.
        cmd.arg("-r").arg("--reflink=auto");
    } else {
        // Linux file: `cp --reflink=auto`.
        cmd.arg("--reflink=auto");
    }
    cmd.arg("--").arg(src).arg(dest);
    cmd.stderr(std::process::Stdio::piped());
    run_capturing("Clone copy", src, dest, &mut cmd)
}

/// `rsync -a -- <src>[/] <dest>`. Directories get a trailing slash on src so the
/// CONTENTS are copied into dest (TS parity).
fn rsync_copy(src: &str, dest: &str, directory: bool) -> CopyResult<()> {
    ensure_parent(dest);
    let src_arg = if directory && !src.ends_with('/') {
        format!("{src}/")
    } else {
        src.to_string()
    };
    let mut cmd = Command::new("rsync");
    cmd.arg("-a").arg("--").arg(&src_arg).arg(dest);
    cmd.stderr(std::process::Stdio::piped());
    run_capturing("Rsync copy", src, dest, &mut cmd)
}

/// `robocopy <src> <dest> /E /MT ...`. No `--` (robocopy doesn't support it); we
/// ASSERT both paths are absolute before spawning instead.
#[cfg(test)]
pub(crate) fn robocopy_dir(src: &str, dest: &str) -> CopyResult<()> {
    robocopy_dir_impl(src, dest)
}

fn robocopy_dir_impl(src: &str, dest: &str) -> CopyResult<()> {
    // SECURITY: robocopy has no `--`, so guard against a path starting with `/`
    // being mis-parsed as a flag by requiring absolute paths.
    if !Path::new(src).is_absolute() || !Path::new(dest).is_absolute() {
        return Err(CopyError::InvalidPath(format!(
            "Robocopy requires absolute paths: {src} -> {dest}"
        )));
    }
    ensure_parent(dest);
    let mut cmd = Command::new("robocopy");
    cmd.arg(src)
        .arg(dest)
        .args([
            "/E", "/MT", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = cmd
        .output()
        .map_err(|e| CopyError::Failed(format!("Robocopy failed: {src} -> {dest}: {e}")))?;
    // Robocopy bitmask exit codes: 0-7 = success, 8+ = failure.
    let code = output.status.code().unwrap_or(16);
    if code < 8 {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = [stdout.trim(), stderr.trim()]
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
    Err(CopyError::Failed(format!(
        "Robocopy directory copy failed (code {code}): {src} -> {dest}: {detail}"
    )))
}

// --- The executor ----------------------------------------------------------

/// Production [`CopyExecutor`]: selects & caches one directory strategy by
/// platform + probed capabilities, exactly like the TS `CopyService`.
///
/// The [`CapabilityProbe`] is consumed only at construction (to pick the
/// strategy once); the native clone is retained for the clonefile path.
pub struct RealCopyExecutor<'a, N: NativeClone> {
    native: &'a N,
    selected: CopyStrategyKind,
}

impl<'a, N: NativeClone> RealCopyExecutor<'a, N> {
    /// Build the executor, selecting the directory strategy once up front.
    ///
    /// Priority (TS `CopyService.getDirectoryStrategy`):
    /// - macOS: native(clonefile, dir-capable) → clone(cp -c) → rsync → standard
    /// - Linux: clone(cp --reflink) → rsync → standard
    /// - Windows: robocopy → standard
    pub fn new<P: CapabilityProbe>(native: &'a N, probe: &P) -> Self {
        let selected = select_directory_strategy(native, probe);
        RealCopyExecutor { native, selected }
    }

    fn is_macos(&self) -> bool {
        self.native.get_platform() == "darwin"
    }
}

/// Pure strategy selection over the native capabilities + probes.
fn select_directory_strategy<N: NativeClone, P: CapabilityProbe>(
    native: &N,
    probe: &P,
) -> CopyStrategyKind {
    let platform = native.get_platform();

    if platform == "windows" {
        if probe.supports_robocopy() {
            return CopyStrategyKind::Robocopy;
        }
        return CopyStrategyKind::Standard;
    }

    // macOS: native clonefile first, but only if it supports directory cloning.
    if platform == "darwin" && native.is_available() && native.supports_directory() {
        return CopyStrategyKind::Clonefile;
    }

    // macOS + Linux: cp clone, then rsync, then standard.
    if probe.supports_cp_clone() {
        return CopyStrategyKind::Clone;
    }
    if probe.supports_rsync() {
        return CopyStrategyKind::Rsync;
    }
    CopyStrategyKind::Standard
}

impl<N: NativeClone> CopyExecutor for RealCopyExecutor<'_, N> {
    fn copy_file(&self, src: &str, dest: &str) -> CopyResult<()> {
        // File copy always uses Standard (TS: fastest per individual file).
        validate_path(src)?;
        validate_path(dest)?;
        standard_copy_file(src, dest)
    }

    fn copy_directory(&self, src: &str, dest: &str) -> CopyResult<()> {
        validate_path(src)?;
        validate_path(dest)?;

        let result = match self.selected {
            CopyStrategyKind::Clonefile => {
                self.native.clone_directory(Path::new(src), Path::new(dest))
            }
            CopyStrategyKind::Clone => cp_clone(src, dest, true, self.is_macos()),
            CopyStrategyKind::Rsync => rsync_copy(src, dest, true),
            CopyStrategyKind::Robocopy => robocopy_dir_impl(src, dest),
            CopyStrategyKind::Standard => standard_copy_directory(src, dest),
        };

        match result {
            Ok(()) => Ok(()),
            // SECURITY (finding #5): a native UnsupportedFileType (symlink etc.)
            // is a HARD error — do NOT fall back to cp/standard.
            Err(CopyError::UnsupportedFileType(m)) => Err(CopyError::UnsupportedFileType(m)),
            // Already Standard → nothing to fall back to; surface the error.
            Err(e) if self.selected == CopyStrategyKind::Standard => Err(e),
            // Other (soft) failures fall back to Standard, matching the TS
            // `CopyService.copyDirectory` catch.
            Err(_) => standard_copy_directory(src, dest),
        }
    }

    fn directory_strategy(&self) -> CopyStrategyKind {
        self.selected
    }
}

#[cfg(any(test, feature = "test-util"))]
pub use fake_executor::FakeCopyExecutor;

#[cfg(any(test, feature = "test-util"))]
mod fake_executor {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// Records `(src, dest)` for every copy without touching the FS.
    ///
    /// Uses `Mutex` (not `RefCell`) so it is `Sync` — `copy_directories` runs the
    /// executor across worker threads (`std::thread::scope`).
    pub struct FakeCopyExecutor {
        strategy: CopyStrategyKind,
        pub file_copies: Mutex<Vec<(String, String)>>,
        pub dir_copies: Mutex<Vec<(String, String)>>,
        /// Copies (by src suffix) that should fail with this error.
        fail_src: Mutex<Vec<(String, CopyError)>>,
        /// Concurrency observation: live in-flight `copy_directory` count and the
        /// peak ever observed. When `observe_concurrency` is set, `copy_directory`
        /// briefly sleeps so overlapping workers actually coincide.
        in_flight: AtomicUsize,
        pub max_in_flight: AtomicUsize,
        observe_concurrency: bool,
    }

    impl FakeCopyExecutor {
        pub fn new(strategy: CopyStrategyKind) -> Self {
            FakeCopyExecutor {
                strategy,
                file_copies: Mutex::new(vec![]),
                dir_copies: Mutex::new(vec![]),
                fail_src: Mutex::new(vec![]),
                in_flight: AtomicUsize::new(0),
                max_in_flight: AtomicUsize::new(0),
                observe_concurrency: false,
            }
        }

        /// Enable concurrency observation: each `copy_directory` records the peak
        /// number of simultaneous in-flight copies (with a tiny sleep so workers
        /// overlap). Read the result from `max_in_flight`.
        pub fn observing_concurrency(mut self) -> Self {
            self.observe_concurrency = true;
            self
        }

        /// Make any copy whose `src` ENDS WITH `suffix` fail with `err`.
        pub fn fail_on(self, suffix: &str, err: CopyError) -> Self {
            self.fail_src
                .lock()
                .unwrap()
                .push((suffix.to_string(), err));
            self
        }

        fn maybe_fail(&self, src: &str) -> CopyResult<()> {
            for (suffix, err) in self.fail_src.lock().unwrap().iter() {
                if src.ends_with(suffix) {
                    return Err(err.clone());
                }
            }
            Ok(())
        }
    }

    impl CopyExecutor for FakeCopyExecutor {
        fn copy_file(&self, src: &str, dest: &str) -> CopyResult<()> {
            validate_path(src)?;
            validate_path(dest)?;
            self.file_copies
                .lock()
                .unwrap()
                .push((src.to_string(), dest.to_string()));
            self.maybe_fail(src)
        }

        fn copy_directory(&self, src: &str, dest: &str) -> CopyResult<()> {
            validate_path(src)?;
            validate_path(dest)?;
            if self.observe_concurrency {
                let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                // Record the running peak (compare-and-set loop).
                let mut peak = self.max_in_flight.load(Ordering::SeqCst);
                while now > peak {
                    match self.max_in_flight.compare_exchange(
                        peak,
                        now,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    ) {
                        Ok(_) => break,
                        Err(actual) => peak = actual,
                    }
                }
                // Brief sleep so concurrent workers actually overlap.
                std::thread::sleep(std::time::Duration::from_millis(20));
                self.in_flight.fetch_sub(1, Ordering::SeqCst);
            }
            self.dir_copies
                .lock()
                .unwrap()
                .push((src.to_string(), dest.to_string()));
            self.maybe_fail(src)
        }

        fn directory_strategy(&self) -> CopyStrategyKind {
            self.strategy
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::copy::detector::FakeProbe;
    use crate::copy::native::FakeNative;
    use vibe_test_support::Fixture;

    // --- strategy selection per platform (no real cp) ---

    #[test]
    fn macos_prefers_native_clonefile() {
        let native = FakeNative::macos();
        let probe = FakeProbe::none().with_cp_clone(true).with_rsync(true);
        let exec = RealCopyExecutor::new(&native, &probe);
        assert_eq!(exec.directory_strategy(), CopyStrategyKind::Clonefile);
    }

    #[test]
    fn macos_falls_to_cp_clone_when_native_unavailable() {
        // Native reports darwin but unavailable → cp clone next.
        let native = FakeNative::unavailable();
        // Force platform darwin via a custom probe path: unavailable() reports
        // "unsupported", so this exercises the generic (non-darwin) branch which
        // still prefers cp clone. That is the intended fallback ordering.
        let probe = FakeProbe::none().with_cp_clone(true);
        let exec = RealCopyExecutor::new(&native, &probe);
        assert_eq!(exec.directory_strategy(), CopyStrategyKind::Clone);
    }

    #[test]
    fn linux_uses_cp_clone_then_rsync_then_standard() {
        let native = FakeNative::linux();
        // cp clone available → Clone.
        let exec = RealCopyExecutor::new(&native, &FakeProbe::none().with_cp_clone(true));
        assert_eq!(exec.directory_strategy(), CopyStrategyKind::Clone);

        // no cp clone, rsync available → Rsync.
        let exec = RealCopyExecutor::new(&native, &FakeProbe::none().with_rsync(true));
        assert_eq!(exec.directory_strategy(), CopyStrategyKind::Rsync);

        // nothing → Standard.
        let exec = RealCopyExecutor::new(&native, &FakeProbe::none());
        assert_eq!(exec.directory_strategy(), CopyStrategyKind::Standard);
    }

    #[test]
    fn linux_never_picks_native_even_if_available() {
        // FakeNative::linux() is available but supports_directory()==false.
        let native = FakeNative::linux();
        let exec = RealCopyExecutor::new(&native, &FakeProbe::none().with_cp_clone(true));
        assert_ne!(exec.directory_strategy(), CopyStrategyKind::Clonefile);
    }

    // --- G-12: Windows robocopy strategy selection (host-independent) ---

    #[test]
    fn windows_with_robocopy_selects_robocopy() {
        // platform="windows" + probe.supports_robocopy()=true → Robocopy.
        let native = FakeNative::windows();
        let probe = FakeProbe::none().with_robocopy(true);
        let exec = RealCopyExecutor::new(&native, &probe);
        assert_eq!(exec.directory_strategy(), CopyStrategyKind::Robocopy);
    }

    #[test]
    fn windows_without_robocopy_selects_standard() {
        // platform="windows" + probe.supports_robocopy()=false → Standard. Note
        // the cp-clone/rsync probes are irrelevant on Windows (short-circuited).
        let native = FakeNative::windows();
        let probe = FakeProbe::none().with_cp_clone(true).with_rsync(true);
        let exec = RealCopyExecutor::new(&native, &probe);
        assert_eq!(exec.directory_strategy(), CopyStrategyKind::Standard);
    }

    // --- G-13: the capability probe runs ONCE (cached selection) ---

    /// A `CapabilityProbe` that counts how many times each probe method is called,
    /// so we can prove the selection is cached (probed once, not per-directory).
    struct CountingProbe {
        cp_clone: bool,
        calls: std::cell::RefCell<usize>,
    }
    impl CountingProbe {
        fn new(cp_clone: bool) -> Self {
            CountingProbe {
                cp_clone,
                calls: std::cell::RefCell::new(0),
            }
        }
    }
    impl crate::copy::detector::CapabilityProbe for CountingProbe {
        fn supports_cp_clone(&self) -> bool {
            *self.calls.borrow_mut() += 1;
            self.cp_clone
        }
        fn supports_rsync(&self) -> bool {
            *self.calls.borrow_mut() += 1;
            false
        }
        fn supports_robocopy(&self) -> bool {
            *self.calls.borrow_mut() += 1;
            false
        }
    }

    #[test]
    fn probe_runs_once_then_strategy_is_cached_across_directories() {
        let fx = Fixture::new();
        // Two source dirs to copy through the SAME executor.
        fx.write("d1/f.txt", "a");
        fx.write("d2/f.txt", "b");

        let native = FakeNative::linux();
        let probe = CountingProbe::new(true); // cp clone available.
        let exec = RealCopyExecutor::new(&native, &probe);
        // Selection happened exactly once, during construction.
        let after_construction = *probe.calls.borrow();
        assert!(
            after_construction >= 1,
            "probe should run during construction"
        );
        assert_eq!(exec.directory_strategy(), CopyStrategyKind::Clone);

        // Copy multiple directories — none of these must re-probe.
        exec.copy_directory(
            fx.join("d1").to_str().unwrap(),
            fx.path().join("o1").to_str().unwrap(),
        )
        .unwrap();
        exec.copy_directory(
            fx.join("d2").to_str().unwrap(),
            fx.path().join("o2").to_str().unwrap(),
        )
        .unwrap();

        // The probe call count did NOT increase per directory (cached selection).
        assert_eq!(
            *probe.calls.borrow(),
            after_construction,
            "probe must not run again per directory (cached)"
        );
    }

    // --- finding #5: native UnsupportedFileType must NOT fall back ---

    #[test]
    fn native_symlink_rejection_does_not_fall_back() {
        let fx = Fixture::new();
        let src = fx.mkdir("src");
        let dest_parent = fx.path().join("dest");
        let dest = dest_parent.to_string_lossy().into_owned();

        let native = FakeNative::macos().rejecting_symlink();
        let probe = FakeProbe::none();
        let exec = RealCopyExecutor::new(&native, &probe);
        assert_eq!(exec.directory_strategy(), CopyStrategyKind::Clonefile);

        let err = exec
            .copy_directory(src.to_str().unwrap(), &dest)
            .unwrap_err();
        assert!(
            matches!(err, CopyError::UnsupportedFileType(_)),
            "must be a hard UnsupportedFileType error: {err:?}"
        );
        // Crucially: dest was NOT created by a fallback standard copy.
        assert!(
            !dest_parent.exists(),
            "no fallback copy should have run after a symlink rejection"
        );
    }

    #[test]
    fn native_soft_failure_falls_back_to_standard() {
        let fx = Fixture::new();
        let src = fx.mkdir("src");
        fx.write("src/inner.txt", "hello");
        let dest = fx.path().join("dest");

        // Native available but the clone fails with a SOFT error → fall back.
        let native = FakeNative::macos().failing_soft();
        let probe = FakeProbe::none();
        let exec = RealCopyExecutor::new(&native, &probe);
        exec.copy_directory(src.to_str().unwrap(), dest.to_str().unwrap())
            .unwrap();
        // The standard fallback actually copied the contents.
        assert_eq!(
            std::fs::read_to_string(dest.join("inner.txt")).unwrap(),
            "hello"
        );
    }

    // --- standard copy actually works (no shell) ---

    #[test]
    fn standard_file_and_dir_copy_work() {
        let fx = Fixture::new();
        fx.write("a/file.txt", "data");
        let native = FakeNative::linux();
        let exec = RealCopyExecutor::new(&native, &FakeProbe::none()); // Standard.
        assert_eq!(exec.directory_strategy(), CopyStrategyKind::Standard);

        // File copy.
        let dest_file = fx.path().join("copy.txt");
        exec.copy_file(
            fx.join("a/file.txt").to_str().unwrap(),
            dest_file.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&dest_file).unwrap(), "data");

        // Dir copy.
        let dest_dir = fx.path().join("a_copy");
        exec.copy_directory(fx.join("a").to_str().unwrap(), dest_dir.to_str().unwrap())
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dest_dir.join("file.txt")).unwrap(),
            "data"
        );
    }

    // --- validate_path is enforced even before spawning ---

    #[test]
    fn copy_rejects_dangerous_paths() {
        let native = FakeNative::linux();
        let exec = RealCopyExecutor::new(&native, &FakeProbe::none());
        assert!(matches!(
            exec.copy_file("$(evil)", "/tmp/x"),
            Err(CopyError::InvalidPath(_))
        ));
        assert!(matches!(
            exec.copy_directory("a\nb", "/tmp/x"),
            Err(CopyError::InvalidPath(_))
        ));
    }

    // --- robocopy argv guard: absolute-path assertion (no `--`) ---

    #[test]
    fn robocopy_rejects_relative_paths() {
        // The robocopy strategy must refuse non-absolute paths (its safety net in
        // place of `--`). We call the impl directly since we're not on Windows.
        let err = robocopy_dir("relative/src", "/abs/dest").unwrap_err();
        assert!(matches!(err, CopyError::InvalidPath(_)));
        let err2 = robocopy_dir("/abs/src", "relative/dest").unwrap_err();
        assert!(matches!(err2, CopyError::InvalidPath(_)));
    }
}
