//! Capability detection for copy strategies (`cp -c`, `rsync`, `robocopy`).
//!
//! Ported from `utils/copy/detector.ts`. The TS probed once and cached; the
//! caching here lives in the [`super::executor::RealCopyExecutor`] (one selected
//! strategy per process). A [`CapabilityProbe`] makes those probes injectable so
//! strategy-selection tests run without invoking real `cp`/`rsync`.

/// Probes for filesystem/tooling capabilities used to pick a directory strategy.
pub trait CapabilityProbe {
    /// Whether the FS supports CoW via `cp` (`cp -c` on macOS, `cp --reflink=auto`
    /// on Linux) — tested by cloning a throwaway temp file.
    fn supports_cp_clone(&self) -> bool;
    /// Whether `rsync` is on PATH (`rsync --version` succeeds).
    fn supports_rsync(&self) -> bool;
    /// Whether `robocopy` is available (Windows only; `where robocopy`).
    fn supports_robocopy(&self) -> bool;
}

/// Production [`CapabilityProbe`] running real probe commands.
pub struct RealProbe;

impl CapabilityProbe for RealProbe {
    fn supports_cp_clone(&self) -> bool {
        // Probe by cloning a temp file. macOS uses `cp -c`; Linux `cp --reflink=auto`.
        let Ok(dir) = tempdir() else {
            return false;
        };
        let src = dir.join("vibe_probe_src");
        let dest = dir.join("vibe_probe_dest");
        if std::fs::write(&src, b"x").is_err() {
            let _ = std::fs::remove_dir_all(&dir);
            return false;
        }

        let args: &[&str] = if cfg!(target_os = "macos") {
            &["-c"]
        } else {
            &["--reflink=auto"]
        };
        let ok = std::process::Command::new("cp")
            .args(args)
            .arg(&src)
            .arg(&dest)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        let _ = std::fs::remove_dir_all(&dir);
        ok
    }

    fn supports_rsync(&self) -> bool {
        std::process::Command::new("rsync")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn supports_robocopy(&self) -> bool {
        if !cfg!(target_os = "windows") {
            return false;
        }
        std::process::Command::new("where")
            .arg("robocopy")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// Create a unique temp directory for the cp-clone probe.
fn tempdir() -> std::io::Result<std::path::PathBuf> {
    let base = std::env::temp_dir();
    let unique = format!(
        "vibe-probe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let dir = base.join(unique);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(any(test, feature = "test-util"))]
pub use fake::FakeProbe;

#[cfg(any(test, feature = "test-util"))]
mod fake {
    use super::CapabilityProbe;

    /// A [`CapabilityProbe`] with fixed answers for each capability.
    pub struct FakeProbe {
        pub cp_clone: bool,
        pub rsync: bool,
        pub robocopy: bool,
    }

    impl FakeProbe {
        /// All capabilities off (forces Standard).
        pub fn none() -> Self {
            FakeProbe {
                cp_clone: false,
                rsync: false,
                robocopy: false,
            }
        }
        pub fn with_cp_clone(mut self, yes: bool) -> Self {
            self.cp_clone = yes;
            self
        }
        pub fn with_rsync(mut self, yes: bool) -> Self {
            self.rsync = yes;
            self
        }
        pub fn with_robocopy(mut self, yes: bool) -> Self {
            self.robocopy = yes;
            self
        }
    }

    impl CapabilityProbe for FakeProbe {
        fn supports_cp_clone(&self) -> bool {
            self.cp_clone
        }
        fn supports_rsync(&self) -> bool {
            self.rsync
        }
        fn supports_robocopy(&self) -> bool {
            self.robocopy
        }
    }
}
