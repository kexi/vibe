//! Filesystem fixtures for vibe's tests.
//!
//! vibe is filesystem-heavy (git repos, worktrees, `.vibe.toml`,
//! `settings.json`), so most tests need a disposable directory tree. This crate
//! wraps `tempfile::TempDir` with a small builder that writes inline file trees
//! and cleans up on drop, so tests get a shared fixture instead of repeating
//! error-prone manual temp-dir setup.

use std::path::{Path, PathBuf};
use tempfile::TempDir;

/// A temporary directory tree that is removed when dropped.
pub struct Fixture {
    dir: TempDir,
}

impl Fixture {
    /// Create an empty fixture rooted at a fresh temp directory.
    pub fn new() -> Self {
        Fixture {
            dir: TempDir::new().expect("failed to create temp dir"),
        }
    }

    /// The fixture root path.
    #[must_use]
    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    /// Resolve a relative path against the fixture root.
    #[must_use]
    pub fn join(&self, rel: impl AsRef<Path>) -> PathBuf {
        self.dir.path().join(rel)
    }

    /// Write a file at `rel` (creating parent directories), returning its path.
    ///
    /// Not `#[must_use]`: many tests write a file purely for its side effect (the
    /// returned path is a convenience), so ignoring it is legitimate.
    pub fn write(&self, rel: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> PathBuf {
        let path = self.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("failed to create parent dirs");
        }
        std::fs::write(&path, contents).expect("failed to write fixture file");
        path
    }

    /// Create a directory at `rel` (and parents), returning its path.
    ///
    /// Not `#[must_use]`: tests often create a directory only for its side effect.
    pub fn mkdir(&self, rel: impl AsRef<Path>) -> PathBuf {
        let path = self.join(rel);
        std::fs::create_dir_all(&path).expect("failed to create fixture dir");
        path
    }
}

impl Default for Fixture {
    fn default() -> Self {
        Fixture::new()
    }
}

/// Build a [`Fixture`] from an inline list of `relative-path => contents` pairs.
///
/// ```
/// use vibe_test_support::fs_fixture;
/// let fx = fs_fixture! {
///     ".vibe.toml" => "[copy]\nfiles = [\".env\"]\n",
///     "src/main.rs" => "fn main() {}",
/// };
/// assert!(fx.join(".vibe.toml").exists());
/// ```
#[macro_export]
macro_rules! fs_fixture {
    ( $( $rel:expr => $contents:expr ),* $(,)? ) => {{
        let fx = $crate::Fixture::new();
        $( let _ = fx.write($rel, $contents); )*
        fx
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_nested_files_and_cleans_up() {
        let path;
        {
            let fx = fs_fixture! {
                "a/b/c.txt" => "hello",
            };
            path = fx.join("a/b/c.txt");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
        }
        // Dropped: the temp tree is gone.
        assert!(!path.exists());
    }

    #[test]
    fn mkdir_creates_directories() {
        let fx = Fixture::new();
        let dir = fx.mkdir("nested/dir");
        assert!(dir.is_dir());
    }
}
