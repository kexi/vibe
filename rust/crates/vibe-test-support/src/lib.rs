//! Filesystem fixtures for vibe's tests.
//!
//! vibe is filesystem-heavy (git repos, worktrees, `.vibe.toml`,
//! `settings.json`), so most tests need a disposable directory tree. This crate
//! wraps `tempfile::TempDir` with a small builder that writes inline file trees
//! and cleans up on drop, so tests get a shared fixture instead of repeating
//! error-prone manual temp-dir setup.
//!
//! It also owns the platform-neutral *fake path* helpers ([`fake_root`],
//! [`fake_home`]). vibe ships on Windows as well as unix, and the unit suite is
//! run on every one of them, so a fixture literal like `"/home/u"` is not a
//! neutral placeholder: on Windows it is a *relative* path (no drive prefix),
//! which the product's own `is_valid_abs_root` correctly rejects. Building fake
//! roots through these helpers keeps such fixtures absolute on every host
//! without scattering `cfg(windows)` through the tests themselves. See #570.

use std::path::{Path, PathBuf};
use tempfile::TempDir;

/// An absolute, non-existent path rooted at a per-platform prefix.
///
/// `fake_root("home/u")` is `/home/u` on unix and `C:\home\u` on Windows.
/// `segments` is always written with `/` separators; they are translated to the
/// host's separator here, so a caller never has to think about it.
///
/// The path intentionally does NOT exist: these helpers are for tests that feed
/// paths through pure logic (validation, joining, rendering). Tests that touch
/// the filesystem want [`Fixture`] instead.
///
/// Why a `C:` drive prefix rather than a UNC or verbatim path on Windows: the
/// product deliberately accepts only `Prefix::Disk` roots for environment-derived
/// directories (`vibe doctor`'s `has_safe_prefix` refuses UNC/device namespaces),
/// so a drive-prefixed fake is the only kind that exercises the success path.
#[must_use]
pub fn fake_root(segments: &str) -> PathBuf {
    let relative: PathBuf = segments.split('/').filter(|s| !s.is_empty()).collect();

    #[cfg(windows)]
    {
        Path::new(r"C:\").join(relative)
    }
    #[cfg(not(windows))]
    {
        Path::new("/").join(relative)
    }
}

/// [`fake_root`] as a `String`, for the many seams that take `&str` paths.
#[must_use]
pub fn fake_root_str(segments: &str) -> String {
    fake_root(segments).to_string_lossy().into_owned()
}

/// The conventional fake HOME: `/home/u` on unix, `C:\home\u` on Windows.
#[must_use]
pub fn fake_home() -> PathBuf {
    fake_root("home/u")
}

/// [`fake_home`] as a `String`.
#[must_use]
pub fn fake_home_str() -> String {
    fake_home().to_string_lossy().into_owned()
}

/// Render a path with `/` separators, whatever the host uses.
///
/// For assertions that compare against a readable `/`-joined literal: normalizing
/// the *actual* value keeps the expected side of the assertion legible instead of
/// forcing every expectation through a `join` chain.
#[must_use]
pub fn to_slash(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().replace('\\', "/")
}

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
    ///
    /// A `/` in `rel` is treated as a path separator on every host. Why not a
    /// plain `Path::join`: Windows accepts `/` as a separator when *opening* a
    /// file, but preserves it verbatim in the `PathBuf`, so `join("repo/.vibe.toml")`
    /// would yield `C:\tmp\repo/.vibe.toml`. Tests then compare that against a
    /// product value built by the product's own `Path::join` (`...\repo\.vibe.toml`)
    /// and fail on separator style alone, even though both name the same file.
    /// Re-joining component-wise makes the fixture path canonical for the host.
    #[must_use]
    pub fn join(&self, rel: impl AsRef<Path>) -> PathBuf {
        let mut path = self.dir.path().to_path_buf();
        for segment in rel.as_ref().to_string_lossy().split('/') {
            if segment.is_empty() {
                continue;
            }
            path.push(segment);
        }
        path
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

    #[test]
    fn join_uses_the_host_separator_for_every_segment() {
        let fx = Fixture::new();
        let joined = fx.join("repo/.vibe.toml");
        // Equivalent to a component-wise join, i.e. no stray `/` survives on a
        // host whose separator is `\`.
        assert_eq!(joined, fx.path().join("repo").join(".vibe.toml"));
    }

    #[test]
    fn fake_roots_are_absolute_on_every_host() {
        assert!(fake_root("home/u").is_absolute());
        assert!(fake_home().is_absolute());
        // No `..` component, so the product's root validation accepts them.
        assert!(!fake_home()
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir)));
    }

    #[test]
    fn to_slash_renders_every_segment_with_a_forward_slash() {
        // Whatever the host separator, the rendered form is `<prefix>a/b/c`.
        let rendered = to_slash(fake_root("a/b/c"));
        assert!(rendered.ends_with("a/b/c"), "got: {rendered}");
        assert!(!rendered.contains('\\'), "got: {rendered}");
    }

    #[test]
    fn fake_root_str_matches_fake_root() {
        assert_eq!(
            fake_root_str("home/u"),
            fake_root("home/u").to_string_lossy()
        );
        assert_eq!(fake_home_str(), fake_home().to_string_lossy());
    }
}
