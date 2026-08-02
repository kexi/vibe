//! Share a directory between worktrees with a symlink instead of copying it.
//!
//! `[copy] symlink = [".cache", ".turbo"]` makes `vibe start` point the new
//! worktree's `.cache` at the origin worktree's `.cache` rather than duplicating
//! it. On a filesystem without reflink support a full copy of a large dependency
//! or cache tree is slow and wastes disk; some directories also do not want
//! per-worktree isolation at all (a shared download cache is preferable).
//!
//! The seam is [`SymlinkCreator`] so the runner is unit-testable without touching
//! the filesystem, mirroring the [`super::strategies::CopyExecutor`] seam.
//!
//! SECURITY: the link SOURCE is resolved with the same containment rules as the
//! copy pipeline — the pattern must be relative, free of `..`/null bytes, and its
//! canonical path must stay inside the canonical origin root. Glob patterns are
//! rejected outright: a symlink entry names one directory to share, and expanding
//! a glob would silently share whatever happens to match. The link
//! DESTINATION is likewise required to stay inside the worktree so a hostile
//! pattern cannot plant a link outside it.
//!
//! Failures are never fatal: a missing target, an escaping path, or an OS refusal
//! (Windows without Developer Mode / `SeCreateSymbolicLinkPrivilege`) warns and
//! the rest of `start` continues, so the worktree stays usable.

use crate::copy::types::validate_path;
use crate::io::Io;
use crate::output::{log_dry_run, warn_log};
use crate::progress::ProgressTracker;
use std::path::{Component, Path, PathBuf};

/// Creates one filesystem symlink. Injected so tests can observe or fail it.
pub trait SymlinkCreator {
    /// Create a symlink at `link` pointing at the directory `target`.
    fn symlink_dir(&self, target: &Path, link: &Path) -> std::io::Result<()>;
}

/// Forward through a reference so `&dyn SymlinkCreator` satisfies the trait.
impl<T: SymlinkCreator + ?Sized> SymlinkCreator for &T {
    fn symlink_dir(&self, target: &Path, link: &Path) -> std::io::Result<()> {
        (**self).symlink_dir(target, link)
    }
}

/// Production [`SymlinkCreator`] over the platform symlink syscall.
pub struct RealSymlinkCreator;

impl SymlinkCreator for RealSymlinkCreator {
    #[cfg(unix)]
    fn symlink_dir(&self, target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    /// Windows needs the *directory* flavor of the call, and it fails without
    /// Developer Mode or `SeCreateSymbolicLinkPrivilege` — the caller downgrades
    /// that error to a warning rather than failing the whole `start`.
    #[cfg(windows)]
    fn symlink_dir(&self, target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(not(any(unix, windows)))]
    fn symlink_dir(&self, _target: &Path, _link: &Path) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "symlinks are not supported on this platform",
        ))
    }
}

/// True if `pattern` names exactly one of the `symlink` entries.
///
/// Comparison is on normalized path components, so `.cache` and `./.cache`
/// (and `a/b` vs `a\b` on Windows) are recognized as the same entry. Callers use
/// this to give a `symlink` entry precedence over a `dirs`/`files` pattern
/// naming the same path.
pub fn is_symlinked_pattern(symlinks: &[String], pattern: &str) -> bool {
    let Some(normalized) = normalize_relative(pattern) else {
        return false;
    };
    symlinks
        .iter()
        .filter_map(|s| normalize_relative(s))
        .any(|s| s == normalized)
}

/// Drop the `dirs`/`files` patterns that a `symlink` entry already covers.
///
/// Returns the retained patterns; the symlinked ones are warned about by the
/// caller only in dry-run (a normal run just shows the symlink phase).
pub fn without_symlinked(symlinks: &[String], patterns: &[String]) -> Vec<String> {
    if symlinks.is_empty() {
        return patterns.to_vec();
    }
    patterns
        .iter()
        .filter(|p| !is_symlinked_pattern(symlinks, p))
        .cloned()
        .collect()
}

/// Normalize a relative pattern to its `Normal` components, or `None` when it is
/// absolute, escapes with `..`, or is empty.
fn normalize_relative(pattern: &str) -> Option<Vec<String>> {
    let path = Path::new(pattern);
    if path.is_absolute() {
        return None;
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            // `./x` is the same entry as `x`.
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts)
}

/// True if `pattern` contains a glob metacharacter (same set as `glob.rs`).
fn has_glob_metacharacter(pattern: &str) -> bool {
    pattern
        .chars()
        .any(|c| matches!(c, '*' | '?' | '[' | ']' | '{'))
}

/// One validated symlink to create.
struct Plan {
    /// The pattern as written in the config (used for messages).
    label: String,
    /// Canonical directory in the origin worktree the link points at.
    target: PathBuf,
    /// Where the link is created inside the new worktree.
    link: PathBuf,
}

/// Create the `[copy] symlink` entries in `worktree_path`, pointing at
/// `origin_root`.
///
/// Every entry is independent: an invalid, missing or unlinkable entry warns and
/// the rest still run, so a worktree is never left half-created by this step.
pub fn create_symlinks(
    io: &impl Io,
    creator: &impl SymlinkCreator,
    tracker: &dyn ProgressTracker,
    patterns: &[String],
    origin_root: &str,
    worktree_path: &str,
    dry_run: bool,
) {
    if patterns.is_empty() {
        return;
    }

    if dry_run {
        log_dry_run(io, "Would symlink directories:");
        for pattern in patterns {
            log_dry_run(io, &format!("  - {pattern}"));
        }
        return;
    }

    let plans = plan_symlinks(io, patterns, origin_root, worktree_path);
    if plans.is_empty() {
        return;
    }

    let phase = tracker.add_phase("Linking shared directories");
    let task_ids: Vec<_> = plans
        .iter()
        .map(|p| tracker.add_task(phase, &p.label))
        .collect();

    for (i, plan) in plans.iter().enumerate() {
        tracker.start_task(task_ids[i]);
        // The worktree is brand new for a fresh `start`, but a re-entry (same
        // branch / --reuse) can find the link already there; remove only a
        // symlink, never a real directory the user may have filled.
        if let Ok(meta) = std::fs::symlink_metadata(&plan.link) {
            if meta.file_type().is_symlink() {
                let _ = std::fs::remove_file(&plan.link);
            } else {
                tracker.complete_task(task_ids[i]);
                warn_log(
                    io,
                    &format!(
                        "Warning: Skipping symlink {}: a real file or directory already exists in the worktree",
                        plan.label
                    ),
                );
                continue;
            }
        }
        if let Some(parent) = plan.link.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        match creator.symlink_dir(&plan.target, &plan.link) {
            Ok(()) => tracker.complete_task(task_ids[i]),
            Err(e) => {
                tracker.fail_task(task_ids[i], &e.to_string());
                warn_log(
                    io,
                    &format!("Warning: Failed to symlink {}: {e}", plan.label),
                );
            }
        }
    }
}

/// Validate every pattern and resolve it to a (target, link) pair, warning about
/// and dropping the ones that cannot be linked.
fn plan_symlinks(
    io: &impl Io,
    patterns: &[String],
    origin_root: &str,
    worktree_path: &str,
) -> Vec<Plan> {
    let mut plans = Vec::new();
    let mut seen = Vec::new();

    // Containment is enforced against the CANONICAL roots; if the origin cannot
    // be canonicalized we cannot enforce it, so nothing is linked (fail closed,
    // same as `glob::expand`).
    let Ok(canonical_origin) = std::fs::canonicalize(origin_root) else {
        warn_log(
            io,
            &format!("Warning: Skipping symlinks: cannot resolve repository root {origin_root}"),
        );
        return plans;
    };
    let Ok(canonical_worktree) = std::fs::canonicalize(worktree_path) else {
        warn_log(
            io,
            &format!("Warning: Skipping symlinks: cannot resolve worktree path {worktree_path}"),
        );
        return plans;
    };

    for pattern in patterns {
        // A symlink entry names ONE directory; a glob would silently share
        // whatever matched, so it is rejected rather than expanded.
        if has_glob_metacharacter(pattern) {
            warn_log(
                io,
                &format!("Warning: Skipping symlink pattern (globs are not supported): {pattern}"),
            );
            continue;
        }
        if validate_path(pattern).is_err() || normalize_relative(pattern).is_none() {
            warn_log(io, &format!("Warning: Skipping invalid pattern: {pattern}"));
            continue;
        }
        let normalized = normalize_relative(pattern).expect("checked above");
        if seen.contains(&normalized) {
            continue;
        }

        let source = canonical_origin.join(normalized.join(std::path::MAIN_SEPARATOR_STR));
        let Ok(target) = std::fs::canonicalize(&source) else {
            warn_log(
                io,
                &format!(
                    "Warning: Skipping symlink {pattern}: target does not exist in {origin_root}"
                ),
            );
            continue;
        };
        // SECURITY: an in-repo symlink could still point outside the origin root;
        // canonicalize + containment is what closes that hole.
        if !target.starts_with(&canonical_origin) {
            warn_log(
                io,
                &format!("Warning: Skipping entry outside repository: {pattern}"),
            );
            continue;
        }
        if !target.is_dir() {
            warn_log(
                io,
                &format!("Warning: Skipping symlink {pattern}: target is not a directory"),
            );
            continue;
        }

        let link = canonical_worktree.join(normalized.join(std::path::MAIN_SEPARATOR_STR));
        // The link path itself is built from `Normal` components only, so it
        // cannot escape; assert it anyway (defense in depth, cheap).
        if !link.starts_with(&canonical_worktree) {
            warn_log(
                io,
                &format!("Warning: Skipping entry outside worktree: {pattern}"),
            );
            continue;
        }

        seen.push(normalized);
        plans.push(Plan {
            label: pattern.clone(),
            target,
            link,
        });
    }

    plans
}

#[cfg(any(test, feature = "test-util"))]
pub use fake_creator::FakeSymlinkCreator;

#[cfg(any(test, feature = "test-util"))]
mod fake_creator {
    use super::*;
    use std::sync::Mutex;

    /// Records `(target, link)` for every symlink without touching the FS, and
    /// can be made to fail like an unprivileged Windows host.
    pub struct FakeSymlinkCreator {
        pub links: Mutex<Vec<(String, String)>>,
        fail: Option<String>,
    }

    impl Default for FakeSymlinkCreator {
        fn default() -> Self {
            FakeSymlinkCreator::new()
        }
    }

    impl FakeSymlinkCreator {
        pub fn new() -> Self {
            FakeSymlinkCreator {
                links: Mutex::new(vec![]),
                fail: None,
            }
        }

        /// Make every `symlink_dir` fail with `message` (the Windows
        /// no-Developer-Mode case).
        pub fn failing(message: &str) -> Self {
            FakeSymlinkCreator {
                links: Mutex::new(vec![]),
                fail: Some(message.to_string()),
            }
        }
    }

    impl SymlinkCreator for FakeSymlinkCreator {
        fn symlink_dir(&self, target: &Path, link: &Path) -> std::io::Result<()> {
            self.links.lock().expect("links mutex poisoned").push((
                target.to_string_lossy().into_owned(),
                link.to_string_lossy().into_owned(),
            ));
            match &self.fail {
                Some(message) => Err(std::io::Error::other(message.clone())),
                None => Ok(()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::FakeIo;
    use crate::progress::NullTracker;
    use vibe_test_support::{fake_root_str, Fixture};

    fn pats(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// (origin fixture, worktree fixture) with `name` present in the origin.
    fn origin_and_worktree(name: &str) -> (Fixture, Fixture) {
        let origin = Fixture::new();
        origin.mkdir(name);
        let worktree = Fixture::new();
        (origin, worktree)
    }

    // --- precedence over dirs/files ---

    #[test]
    fn symlinked_pattern_is_recognized_regardless_of_dot_slash() {
        let symlinks = pats(&[".cache"]);
        assert!(is_symlinked_pattern(&symlinks, ".cache"));
        assert!(is_symlinked_pattern(&symlinks, "./.cache"));
        assert!(!is_symlinked_pattern(&symlinks, ".cache2"));
    }

    #[test]
    fn without_symlinked_drops_matching_dirs_only() {
        let kept = without_symlinked(&pats(&[".turbo"]), &pats(&["node_modules", ".turbo"]));
        assert_eq!(kept, pats(&["node_modules"]));
    }

    #[test]
    fn without_symlinked_is_identity_when_no_symlinks_configured() {
        let patterns = pats(&["node_modules"]);
        assert_eq!(without_symlinked(&[], &patterns), patterns);
    }

    // --- creation ---

    #[test]
    fn creates_a_link_pointing_at_the_origin_directory() {
        let (origin, worktree) = origin_and_worktree(".cache");
        let io = FakeIo::new();
        let creator = FakeSymlinkCreator::new();
        create_symlinks(
            &io,
            &creator,
            &NullTracker,
            &pats(&[".cache"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        let links = creator.links.lock().unwrap();
        assert_eq!(links.len(), 1);
        assert!(links[0].0.ends_with(".cache"), "target: {}", links[0].0);
        assert!(
            links[0].1.starts_with(
                &std::fs::canonicalize(worktree.path())
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            ),
            "link must live inside the worktree: {}",
            links[0].1
        );
    }

    #[test]
    fn real_creator_produces_a_symlink_resolving_to_the_origin() {
        let (origin, worktree) = origin_and_worktree(".cache");
        origin.write(".cache/data.bin", "shared");
        let io = FakeIo::new();
        create_symlinks(
            &io,
            &RealSymlinkCreator,
            &NullTracker,
            &pats(&[".cache"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        let link = worktree.path().join(".cache");
        let meta = std::fs::symlink_metadata(&link).expect("link should exist");
        assert!(meta.file_type().is_symlink(), "must be a symlink");
        // Reading THROUGH the link sees the origin's content — that is the shared
        // state the feature promises.
        assert_eq!(
            std::fs::read_to_string(link.join("data.bin")).unwrap(),
            "shared"
        );
    }

    #[test]
    fn missing_target_warns_and_creates_nothing() {
        let origin = Fixture::new();
        let worktree = Fixture::new();
        let io = FakeIo::new();
        let creator = FakeSymlinkCreator::new();
        create_symlinks(
            &io,
            &creator,
            &NullTracker,
            &pats(&["absent"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        assert!(creator.links.lock().unwrap().is_empty());
        assert!(
            io.stderr_text().contains("target does not exist"),
            "stderr: {}",
            io.stderr_text()
        );
    }

    #[test]
    fn creation_failure_warns_and_continues_to_the_next_entry() {
        let origin = Fixture::new();
        origin.mkdir(".cache");
        origin.mkdir(".turbo");
        let worktree = Fixture::new();
        let io = FakeIo::new();
        // Emulates Windows without Developer Mode: every call fails.
        let creator = FakeSymlinkCreator::failing("A required privilege is not held");
        create_symlinks(
            &io,
            &creator,
            &NullTracker,
            &pats(&[".cache", ".turbo"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        // Both were attempted despite the first failing.
        assert_eq!(creator.links.lock().unwrap().len(), 2);
        let stderr = io.stderr_text();
        assert!(
            stderr.contains("Failed to symlink .cache"),
            "stderr: {stderr}"
        );
        assert!(
            stderr.contains("Failed to symlink .turbo"),
            "stderr: {stderr}"
        );
    }

    #[test]
    fn target_that_is_a_file_is_rejected() {
        let origin = Fixture::new();
        origin.write("notadir", "x");
        let worktree = Fixture::new();
        let io = FakeIo::new();
        let creator = FakeSymlinkCreator::new();
        create_symlinks(
            &io,
            &creator,
            &NullTracker,
            &pats(&["notadir"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        assert!(creator.links.lock().unwrap().is_empty());
        assert!(io.stderr_text().contains("is not a directory"));
    }

    #[test]
    fn duplicate_entries_are_linked_once() {
        let (origin, worktree) = origin_and_worktree(".cache");
        let io = FakeIo::new();
        let creator = FakeSymlinkCreator::new();
        create_symlinks(
            &io,
            &creator,
            &NullTracker,
            &pats(&[".cache", "./.cache"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        assert_eq!(creator.links.lock().unwrap().len(), 1);
    }

    #[test]
    fn dry_run_logs_and_creates_nothing() {
        let (origin, worktree) = origin_and_worktree(".cache");
        let io = FakeIo::new();
        let creator = FakeSymlinkCreator::new();
        create_symlinks(
            &io,
            &creator,
            &NullTracker,
            &pats(&[".cache"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            true,
        );
        assert!(creator.links.lock().unwrap().is_empty());
        let stderr = io.stderr_text();
        assert!(stderr.contains("[dry-run] Would symlink directories:"));
        assert!(stderr.contains("  - .cache"));
    }

    #[test]
    fn existing_real_directory_in_worktree_is_not_replaced() {
        let (origin, worktree) = origin_and_worktree(".cache");
        // The worktree already has a REAL .cache (e.g. a hook created it).
        worktree.write(".cache/keep.txt", "mine");
        let io = FakeIo::new();
        create_symlinks(
            &io,
            &RealSymlinkCreator,
            &NullTracker,
            &pats(&[".cache"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        // The user's real directory survives untouched.
        assert_eq!(
            std::fs::read_to_string(worktree.path().join(".cache/keep.txt")).unwrap(),
            "mine"
        );
        assert!(io
            .stderr_text()
            .contains("a real file or directory already exists"));
    }

    #[test]
    fn a_stale_symlink_is_replaced_on_re_entry() {
        let (origin, worktree) = origin_and_worktree(".cache");
        let io = FakeIo::new();
        // Two runs in a row (the `start` re-entry / --reuse path).
        for _ in 0..2 {
            create_symlinks(
                &io,
                &RealSymlinkCreator,
                &NullTracker,
                &pats(&[".cache"]),
                origin.path().to_str().unwrap(),
                worktree.path().to_str().unwrap(),
                false,
            );
        }
        let meta = std::fs::symlink_metadata(worktree.path().join(".cache")).unwrap();
        assert!(meta.file_type().is_symlink());
        assert!(
            !io.stderr_text().contains("Failed to symlink"),
            "re-entry must not warn: {}",
            io.stderr_text()
        );
    }

    // --- SECURITY: containment ---

    #[test]
    fn absolute_pattern_is_rejected() {
        let origin = Fixture::new();
        let worktree = Fixture::new();
        let io = FakeIo::new();
        let creator = FakeSymlinkCreator::new();
        let absolute = fake_root_str("etc");
        create_symlinks(
            &io,
            &creator,
            &NullTracker,
            &pats(&[&absolute]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        assert!(creator.links.lock().unwrap().is_empty());
        assert!(io.stderr_text().contains("Skipping invalid pattern"));
    }

    #[test]
    fn parent_traversal_pattern_is_rejected() {
        let origin = Fixture::new();
        let worktree = Fixture::new();
        let io = FakeIo::new();
        let creator = FakeSymlinkCreator::new();
        create_symlinks(
            &io,
            &creator,
            &NullTracker,
            &pats(&["../outside"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        assert!(creator.links.lock().unwrap().is_empty());
        assert!(io.stderr_text().contains("Skipping invalid pattern"));
    }

    #[test]
    fn glob_pattern_is_rejected() {
        let origin = Fixture::new();
        origin.mkdir("packages/a");
        let worktree = Fixture::new();
        let io = FakeIo::new();
        let creator = FakeSymlinkCreator::new();
        create_symlinks(
            &io,
            &creator,
            &NullTracker,
            &pats(&["packages/*"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        assert!(creator.links.lock().unwrap().is_empty());
        assert!(io.stderr_text().contains("globs are not supported"));
    }

    /// A directory inside the origin that is itself a symlink OUT of the repo
    /// must not become a shared entry — canonicalization is what catches it.
    #[cfg(unix)]
    #[test]
    fn in_repo_symlink_pointing_outside_the_origin_is_rejected() {
        use std::os::unix::fs::symlink;
        let outside = Fixture::new();
        let secret = outside.mkdir("secrets");

        let origin = Fixture::new();
        symlink(&secret, origin.path().join("escape")).unwrap();
        let worktree = Fixture::new();

        let io = FakeIo::new();
        let creator = FakeSymlinkCreator::new();
        create_symlinks(
            &io,
            &creator,
            &NullTracker,
            &pats(&["escape"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        assert!(
            creator.links.lock().unwrap().is_empty(),
            "must not share a directory outside the origin worktree"
        );
        assert!(io
            .stderr_text()
            .contains("Skipping entry outside repository"));
    }

    #[test]
    fn null_byte_pattern_is_rejected() {
        let origin = Fixture::new();
        let worktree = Fixture::new();
        let io = FakeIo::new();
        let creator = FakeSymlinkCreator::new();
        create_symlinks(
            &io,
            &creator,
            &NullTracker,
            &pats(&["bad\0name"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        assert!(creator.links.lock().unwrap().is_empty());
        assert!(io.stderr_text().contains("Skipping invalid pattern"));
    }

    #[test]
    fn empty_patterns_do_nothing() {
        let io = FakeIo::new();
        let creator = FakeSymlinkCreator::new();
        create_symlinks(&io, &creator, &NullTracker, &[], "/o", "/w", false);
        assert!(creator.links.lock().unwrap().is_empty());
        assert!(io.stderr_text().is_empty());
    }
}
