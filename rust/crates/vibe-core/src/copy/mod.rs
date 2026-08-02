//! Copy subsystem: strategy detection, selection and execution.
//!
//! Ported from `packages/core/src/utils/copy/`. Layers:
//! - [`types`]: [`CopyStrategyKind`], [`CopyError`], `validate_path`.
//! - [`native`]: the [`NativeClone`] seam over `vibe-native`.
//! - [`detector`]: the [`CapabilityProbe`] seam (`cp -c`/`rsync`/`robocopy`).
//! - [`strategies`]: the five strategies + the [`CopyExecutor`] that selects and
//!   caches one directory strategy per platform.
//! - [`symlink`]: the `[copy] symlink` alternative — share a directory with the
//!   origin worktree instead of duplicating it.

pub mod detector;
pub mod native;
pub mod strategies;
pub mod symlink;
pub mod types;

pub use detector::{CapabilityProbe, RealProbe};
pub use native::{NativeClone, RealNativeClone};
pub use strategies::{CopyExecutor, RealCopyExecutor};
pub use symlink::{RealSymlinkCreator, SymlinkCreator};
pub use types::{validate_path, CopyError, CopyResult, CopyStrategyKind};

#[cfg(any(test, feature = "test-util"))]
pub use detector::FakeProbe;
#[cfg(any(test, feature = "test-util"))]
pub use native::FakeNative;
#[cfg(any(test, feature = "test-util"))]
pub use strategies::FakeCopyExecutor;
#[cfg(any(test, feature = "test-util"))]
pub use symlink::FakeSymlinkCreator;
