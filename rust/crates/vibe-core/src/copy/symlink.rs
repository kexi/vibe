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
//! pattern cannot plant a link outside it; since the destination does not exist
//! yet it cannot be canonicalized, so its existing ancestors are additionally
//! walked with `symlink_metadata` BEFORE any filesystem mutation on that path
//! ([`ancestors_are_contained`]) — a lexical `starts_with` alone would let a
//! symlinked intermediate directory redirect the removal, the `create_dir_all`
//! and the creation alike.
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

/// The entries a `symlink` actually exists for, plus how to compare paths
/// against them.
///
/// Built by [`create_symlinks`] from the plans that SUCCEEDED, never from the
/// raw config: a pattern rejected as a glob / invalid / missing / escaping
/// creates no link, so it must not suppress an unrelated `files`/`dirs` copy.
#[derive(Debug, Clone, Default)]
pub struct SymlinkedPaths {
    /// Normalized components of each entry a link was created for.
    entries: Vec<Vec<String>>,
    /// True when the destination filesystem matches names case-insensitively
    /// (APFS/NTFS by default), so `.Cache` and `.cache` name the SAME entry
    /// there and a copy to either spelling would write through the link.
    ignore_case: bool,
}

impl SymlinkedPaths {
    /// An empty set (nothing is shared) — the identity for [`without_symlinked`].
    pub fn none() -> Self {
        SymlinkedPaths::default()
    }

    /// Build from raw patterns, for callers that have no filesystem to probe
    /// (dry-run listings and unit tests).
    pub fn from_patterns(patterns: &[String], ignore_case: bool) -> Self {
        SymlinkedPaths {
            entries: patterns
                .iter()
                .filter_map(|p| normalize_relative(p))
                .collect(),
            ignore_case,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// True if `path` is a shared entry, or lives under one, or contains one.
    ///
    /// Comparison is on normalized path components, so `.cache` and `./.cache`
    /// (and `a/b` vs `a\b` on Windows) are recognized as the same entry, and it
    /// folds case when the destination filesystem does.
    ///
    /// The relation is checked in BOTH directions on purpose:
    /// - `path` == the entry, or under it (`.cache/pkg` under `.cache`): copying
    ///   it would write THROUGH the link into the origin worktree, corrupting
    ///   the shared directory rather than merely wasting time.
    /// - `path` is an ANCESTOR of the entry (`a` when `a/b` is shared): copying
    ///   it would recreate `a/b` as a real directory and either clobber the link
    ///   or, with a merging strategy, write through it.
    pub fn covers(&self, path: &str) -> bool {
        let Some(normalized) = normalize_relative(path) else {
            return false;
        };
        self.entries
            .iter()
            .any(|entry| self.is_prefix(entry, &normalized) || self.is_prefix(&normalized, entry))
    }

    /// True if `prefix` is a component-wise prefix of `full`.
    fn is_prefix(&self, prefix: &[String], full: &[String]) -> bool {
        prefix.len() <= full.len()
            && prefix.iter().zip(full).all(|(a, b)| {
                if self.ignore_case {
                    a.eq_ignore_ascii_case(b)
                } else {
                    a == b
                }
            })
    }
}

/// Drop the copy entries that a shared `symlink` entry already covers.
///
/// Callers MUST apply this AFTER glob expansion: a pattern like `.*` does not
/// compare equal to `.cache`, but expands to it, so filtering the raw patterns
/// alone would let the expansion copy straight over (and through) the link.
pub fn without_symlinked(symlinks: &SymlinkedPaths, paths: &[String]) -> Vec<String> {
    if symlinks.is_empty() {
        return paths.to_vec();
    }
    paths
        .iter()
        .filter(|p| !symlinks.covers(p))
        .cloned()
        .collect()
}

/// Probe whether `dir`'s filesystem matches names case-insensitively.
///
/// The exclusion in [`SymlinkedPaths::covers`] is LEXICAL — it cannot see that
/// on APFS/NTFS a copy to `.cache` lands on the `.Cache` link and writes through
/// it into the origin. Rather than assume per-OS (macOS can mount case-sensitive
/// APFS, Linux can mount ciopfs/exFAT), ask the actual destination: create a
/// uniquely-named lowercase probe and look for its uppercase spelling.
///
/// Unknown (the probe cannot be written) folds case, because over-excluding
/// costs a skipped copy while under-excluding corrupts the shared directory.
fn filesystem_ignores_case(dir: &Path) -> bool {
    let unique = std::process::id();
    let lower = dir.join(format!(".vibe-case-probe-{unique}"));
    let upper = dir.join(format!(".VIBE-CASE-PROBE-{unique}"));
    if std::fs::write(&lower, b"").is_err() {
        return true;
    }
    let ignores = std::fs::symlink_metadata(&upper).is_ok();
    let _ = std::fs::remove_file(&lower);
    ignores
}

/// Normalize a relative pattern to its `Normal` components, or `None` when it
/// carries any component that is not `Normal` or `.` — a root component, a `..`,
/// or a Windows drive prefix (`C:foo` has one without being absolute) — or when
/// no `Normal` component is left, as for `""` and `"."`.
pub(crate) fn normalize_relative(pattern: &str) -> Option<Vec<String>> {
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
    /// `label` reduced to its `Normal` components — what the copy exclusion
    /// compares against once the link exists.
    normalized: Vec<String>,
    /// Canonical directory in the origin worktree the link points at.
    target: PathBuf,
    /// Where the link is created inside the new worktree.
    link: PathBuf,
    /// Canonical worktree root `link` must stay inside (re-checked at creation).
    worktree_root: PathBuf,
}

/// Delete an existing symlink at `link`.
///
/// Unix has one unlink for both flavors, but a Windows DIRECTORY symlink is a
/// reparse point on a directory entry and needs `remove_dir`; calling
/// `remove_file` on it fails, and the caller would then hit `AlreadyExists` and
/// leave the stale link behind. Try the type-appropriate call first and fall
/// back to the other, since a re-entry can find either flavor.
fn remove_symlink(link: &Path, meta: &std::fs::Metadata) -> std::io::Result<()> {
    if cfg!(windows) && meta.is_dir() {
        // `is_dir()` on symlink_metadata is false for a FILE symlink, so this
        // only takes the directory branch for a real directory reparse point.
        return std::fs::remove_dir(link).or_else(|_| std::fs::remove_file(link));
    }
    std::fs::remove_file(link).or_else(|e| {
        if cfg!(windows) {
            std::fs::remove_dir(link)
        } else {
            Err(e)
        }
    })
}

/// SECURITY: confirm no existing ancestor of `link` is a symlink that could
/// redirect the creation outside `root`.
///
/// `plan_symlinks` can only compare the link path LEXICALLY (it does not exist
/// yet, so it cannot be canonicalized). That leaves the classic hole: for
/// `a/b`, if `a` is a symlink to somewhere else, the lexical check passes but
/// the syscall follows `a` and plants the link outside the worktree. Walking the
/// ancestors with `symlink_metadata` (never following) closes it; each existing
/// ancestor is additionally canonicalized so a chain of in-worktree links cannot
/// walk out either.
fn ancestors_are_contained(link: &Path, root: &Path) -> Result<(), String> {
    let Some(parent) = link.parent() else {
        return Err("link has no parent directory".to_string());
    };
    // Only the segments BELOW the root are attacker-influenced; the root itself
    // was canonicalized by the caller.
    let Ok(relative) = parent.strip_prefix(root) else {
        return Err(format!("{} escapes the worktree", link.display()));
    };

    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        let Ok(meta) = std::fs::symlink_metadata(&current) else {
            // Does not exist: nothing can be followed through it.
            continue;
        };
        if meta.file_type().is_symlink() {
            return Err(format!(
                "{} is a symlink, which could redirect the link outside the worktree",
                current.display()
            ));
        }
        let Ok(canonical) = std::fs::canonicalize(&current) else {
            return Err(format!("cannot resolve {}", current.display()));
        };
        if !canonical.starts_with(root) {
            return Err(format!(
                "{} resolves outside the worktree",
                current.display()
            ));
        }
    }
    Ok(())
}

/// Create the `[copy] symlink` entries in `worktree_path`, pointing at
/// `origin_root`.
///
/// Every entry is independent: an invalid, missing or unlinkable entry warns and
/// the rest still run, so a worktree is never left half-created by this step.
///
/// Returns the entries a link now EXISTS for, so the copy runners exclude
/// exactly those. An entry that was rejected or failed to link is deliberately
/// absent: no link is in the way, so a `files`/`dirs` pattern naming it should
/// copy normally rather than be silently dropped.
pub fn create_symlinks(
    io: &impl Io,
    creator: &impl SymlinkCreator,
    tracker: &dyn ProgressTracker,
    patterns: &[String],
    origin_root: &str,
    worktree_path: &str,
    dry_run: bool,
) -> SymlinkedPaths {
    if patterns.is_empty() {
        return SymlinkedPaths::none();
    }

    if dry_run {
        log_dry_run(io, "Would symlink directories:");
        for pattern in patterns {
            log_dry_run(io, &format!("  - {pattern}"));
        }
        // Nothing exists to probe (the worktree is not created in a dry run), so
        // describe the intent: every pattern, compared case-insensitively so the
        // preview never UNDER-states what a real run would skip copying.
        return SymlinkedPaths::from_patterns(patterns, true);
    }

    let plans = plan_symlinks(io, patterns, origin_root, worktree_path);
    if plans.is_empty() {
        return SymlinkedPaths::none();
    }

    // Every plan shares one canonical worktree root, so one probe answers for
    // all of them.
    let mut linked = SymlinkedPaths {
        entries: Vec::new(),
        ignore_case: filesystem_ignores_case(&plans[0].worktree_root),
    };

    let phase = tracker.add_phase("Linking shared directories");
    let task_ids: Vec<_> = plans
        .iter()
        .map(|p| tracker.add_task(phase, &p.label))
        .collect();

    for (i, plan) in plans.iter().enumerate() {
        tracker.start_task(task_ids[i]);
        // SECURITY: every step below MUTATES the link path — the stale-link
        // removal, the `create_dir_all`, and the creation itself. A symlinked
        // ancestor (planted by a pre_start hook, or left by another tool) would
        // redirect all three, so containment is verified BEFORE the first of
        // them and not merely before the syscall: an unguarded `remove_file` or
        // `create_dir_all` through such a link is already an external side
        // effect, even if the link creation is later refused.
        if let Err(reason) = ancestors_are_contained(&plan.link, &plan.worktree_root) {
            tracker.fail_task(task_ids[i], &reason);
            warn_log(
                io,
                &format!("Warning: Skipping symlink {}: {reason}", plan.label),
            );
            continue;
        }
        // The worktree is brand new for a fresh `start`, but a re-entry (same
        // branch / --reuse) can find the link already there; remove only a
        // symlink, never a real directory the user may have filled.
        if let Ok(meta) = std::fs::symlink_metadata(&plan.link) {
            if meta.file_type().is_symlink() {
                if let Err(e) = remove_symlink(&plan.link, &meta) {
                    // Recreating over a link we could not delete would fail with
                    // AlreadyExists and leave the STALE link in place, silently
                    // pointing the worktree at the wrong directory; say so. The
                    // stale link is still in the way, so the copy must keep
                    // clear of it.
                    linked.entries.push(plan.normalized.clone());
                    tracker.fail_task(task_ids[i], &e.to_string());
                    warn_log(
                        io,
                        &format!(
                            "Warning: Failed to remove the existing symlink {}: {e}",
                            plan.label
                        ),
                    );
                    continue;
                }
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
        // `create_dir_all` only creates REAL directories, so it cannot introduce
        // a symlinked ancestor; the check above still holds here.

        match creator.symlink_dir(&plan.target, &plan.link) {
            Ok(()) => {
                linked.entries.push(plan.normalized.clone());
                tracker.complete_task(task_ids[i]);
            }
            Err(e) => {
                tracker.fail_task(task_ids[i], &e.to_string());
                warn_log(
                    io,
                    &format!("Warning: Failed to symlink {}: {e}", plan.label),
                );
            }
        }
    }

    linked
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

        seen.push(normalized.clone());
        plans.push(Plan {
            label: pattern.clone(),
            normalized,
            target,
            link,
            worktree_root: canonical_worktree.clone(),
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

    /// True if this host can actually create a directory symlink.
    ///
    /// Production treats a privilege-denied `symlink_dir` as non-fatal (Windows
    /// without Developer Mode / `SeCreateSymbolicLinkPrivilege`), so a
    /// round-trip test that asserts unconditional SUCCESS would report a host
    /// limitation as a product bug. Probe the capability instead of hard-coding
    /// a platform: the denied path has its own test below.
    fn can_create_symlinks() -> bool {
        let probe = Fixture::new();
        let target = probe.mkdir("target");
        RealSymlinkCreator
            .symlink_dir(&target, &probe.path().join("link"))
            .is_ok()
    }

    // --- precedence over dirs/files ---

    /// Case-sensitive comparison (the Linux / case-sensitive-volume default).
    fn shared(items: &[&str]) -> SymlinkedPaths {
        SymlinkedPaths::from_patterns(&pats(items), false)
    }

    #[test]
    fn symlinked_pattern_is_recognized_regardless_of_dot_slash() {
        let symlinks = shared(&[".cache"]);
        assert!(symlinks.covers(".cache"));
        assert!(symlinks.covers("./.cache"));
        assert!(!symlinks.covers(".cache2"));
    }

    #[test]
    fn without_symlinked_drops_matching_dirs_only() {
        let kept = without_symlinked(&shared(&[".turbo"]), &pats(&["node_modules", ".turbo"]));
        assert_eq!(kept, pats(&["node_modules"]));
    }

    /// A path UNDER a shared directory would be copied THROUGH the link into the
    /// origin worktree, so it is excluded too.
    #[test]
    fn descendants_of_a_symlinked_entry_are_excluded() {
        let symlinks = shared(&[".cache"]);
        assert!(symlinks.covers(".cache/pkg"));
        assert!(symlinks.covers(".cache/pkg/index.json"));
        // A sibling with a shared name PREFIX is not a descendant.
        assert!(!symlinks.covers(".cachex"));
    }

    /// Copying an ANCESTOR would recreate the shared child as a real directory
    /// (or write through the link), so it is excluded as well.
    #[test]
    fn ancestors_of_a_symlinked_entry_are_excluded() {
        let symlinks = shared(&["packages/app/node_modules"]);
        assert!(symlinks.covers("packages/app"));
        assert!(symlinks.covers("packages"));
        assert!(!symlinks.covers("packages/other"));
    }

    /// On a case-insensitive volume `.Cache` and `.cache` are the SAME directory
    /// entry, so a copy to either spelling would write through the link; on a
    /// case-sensitive one they are two directories and both must be copied.
    #[test]
    fn case_folding_follows_the_destination_filesystem() {
        assert!(SymlinkedPaths::from_patterns(&pats(&[".Cache"]), true).covers(".cache"));
        assert!(SymlinkedPaths::from_patterns(&pats(&[".Cache"]), true).covers(".CACHE/pkg"));
        assert!(!SymlinkedPaths::from_patterns(&pats(&[".Cache"]), false).covers(".cache"));
    }

    /// The probe must agree with what the filesystem actually does, so an
    /// opposite-case spelling of a real file is visible iff the probe says so.
    #[test]
    fn case_probe_matches_the_actual_filesystem_behavior() {
        let fx = Fixture::new();
        fx.write("probe.txt", "x");
        let observed = std::fs::symlink_metadata(fx.path().join("PROBE.TXT")).is_ok();
        assert_eq!(filesystem_ignores_case(fx.path()), observed);
    }

    #[test]
    fn without_symlinked_is_identity_when_no_symlinks_configured() {
        let patterns = pats(&["node_modules"]);
        assert_eq!(
            without_symlinked(&SymlinkedPaths::none(), &patterns),
            patterns
        );
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
        if !can_create_symlinks() {
            return;
        }
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
        if !can_create_symlinks() {
            return;
        }
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

    /// A DIRECTORY symlink left over from a previous run must be refreshed to
    /// the current origin. On Windows the removal needs directory semantics, so
    /// this pins that a re-entry actually re-points the link rather than
    /// silently keeping the stale one.
    #[test]
    fn a_stale_directory_link_is_repointed_at_the_current_origin() {
        if !can_create_symlinks() {
            return;
        }
        let old_origin = Fixture::new();
        old_origin.write(".cache/marker.txt", "old");
        let new_origin = Fixture::new();
        new_origin.write(".cache/marker.txt", "new");
        let worktree = Fixture::new();

        let io = FakeIo::new();
        for origin in [&old_origin, &new_origin] {
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

        let link = worktree.path().join(".cache");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        // The stale link was actually removed and recreated, not left in place.
        assert_eq!(
            std::fs::read_to_string(link.join("marker.txt")).unwrap(),
            "new",
            "stale link was not refreshed: {}",
            io.stderr_text()
        );
        assert!(
            !io.stderr_text().contains("Failed to"),
            "refresh must not warn: {}",
            io.stderr_text()
        );
    }

    // --- SECURITY: containment ---

    /// A nested entry whose PARENT inside the worktree is a symlink pointing
    /// out must not be created: the lexical containment check on the not-yet-
    /// existing link path passes, but the syscall would follow the parent and
    /// plant the link outside the worktree.
    #[cfg(unix)]
    #[test]
    fn symlinked_intermediate_directory_in_the_worktree_is_rejected() {
        use std::os::unix::fs::symlink;
        let origin = Fixture::new();
        origin.mkdir("packages/app/node_modules");

        let outside = Fixture::new();
        outside.mkdir("packages/app");

        let worktree = Fixture::new();
        // `packages` inside the worktree is a link OUT of it (e.g. planted by a
        // pre_start hook or left by a previous tool).
        symlink(outside.path().join("packages"), worktree.join("packages")).unwrap();

        let io = FakeIo::new();
        let creator = FakeSymlinkCreator::new();
        let linked = create_symlinks(
            &io,
            &creator,
            &NullTracker,
            &pats(&["packages/app/node_modules"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );

        assert!(
            creator.links.lock().unwrap().is_empty(),
            "must not create a link through a symlinked parent"
        );
        assert!(
            linked.is_empty(),
            "nothing was shared, so nothing is excluded"
        );
        assert!(
            io.stderr_text().contains("is a symlink"),
            "stderr: {}",
            io.stderr_text()
        );
        // And nothing was planted in the outside directory.
        assert!(!outside.path().join("packages/app/node_modules").exists());
    }

    /// The containment guard has to fire before the FIRST mutation, not just
    /// before the symlink syscall: the stale-link removal and the
    /// `create_dir_all` on the same path would otherwise follow a symlinked
    /// ancestor and delete / create entries OUTSIDE the worktree even though the
    /// link itself is later refused.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_ancestor_causes_no_external_filesystem_change() {
        use std::os::unix::fs::symlink;
        let origin = Fixture::new();
        origin.mkdir("packages/app/node_modules");

        let outside = Fixture::new();
        // The victim state: an existing symlink that `remove_symlink` would
        // unlink, and a missing `deep/` that `create_dir_all` would create.
        outside.mkdir("packages/app");
        let bait = outside.mkdir("bait");
        symlink(&bait, outside.path().join("packages/app/node_modules")).unwrap();

        let worktree = Fixture::new();
        symlink(outside.path().join("packages"), worktree.join("packages")).unwrap();

        let io = FakeIo::new();
        create_symlinks(
            &io,
            &RealSymlinkCreator,
            &NullTracker,
            &pats(&["packages/app/node_modules", "packages/deep/nested"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );

        // The external symlink still exists and still points at the bait: the
        // removal never ran.
        let victim = outside.path().join("packages/app/node_modules");
        let meta = std::fs::symlink_metadata(&victim).expect("external link must survive");
        assert!(meta.file_type().is_symlink());
        assert_eq!(std::fs::read_link(&victim).unwrap(), bait);
        // And no directory was created out there either.
        assert!(
            !outside.path().join("packages/deep").exists(),
            "create_dir_all must not run through a symlinked ancestor"
        );
    }

    /// The nested case with an ordinary (non-symlinked) parent still works, so
    /// the guard above rejects the attack and not the feature.
    #[test]
    fn nested_entry_with_a_real_parent_is_linked() {
        let origin = Fixture::new();
        origin.mkdir("packages/app/node_modules");
        let worktree = Fixture::new();
        let io = FakeIo::new();
        let creator = FakeSymlinkCreator::new();
        create_symlinks(
            &io,
            &creator,
            &NullTracker,
            &pats(&["packages/app/node_modules"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        assert_eq!(
            creator.links.lock().unwrap().len(),
            1,
            "{}",
            io.stderr_text()
        );
    }

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

    // --- the copy exclusion is derived from what was actually linked ---

    /// A rejected pattern creates no link, so it must not suppress a `dirs`
    /// copy of the same path — `symlink = ["packages/*"]` is refused, and
    /// `dirs = ["packages"]` must still be copied.
    #[test]
    fn a_rejected_pattern_does_not_suppress_an_unrelated_copy() {
        let origin = Fixture::new();
        origin.mkdir("packages/a");
        let worktree = Fixture::new();
        let io = FakeIo::new();
        let linked = create_symlinks(
            &io,
            &FakeSymlinkCreator::new(),
            &NullTracker,
            &pats(&["packages/*", "absent"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        assert!(linked.is_empty());
        assert_eq!(
            without_symlinked(&linked, &pats(&["packages"])),
            pats(&["packages"])
        );
    }

    /// A link that could NOT be created (Windows without Developer Mode) leaves
    /// the path free, so the `dirs` copy should run as the fallback rather than
    /// be dropped and leave the worktree without the directory at all.
    #[test]
    fn a_failed_creation_does_not_suppress_the_copy_fallback() {
        let (origin, worktree) = origin_and_worktree(".cache");
        let io = FakeIo::new();
        let linked = create_symlinks(
            &io,
            &FakeSymlinkCreator::failing("A required privilege is not held"),
            &NullTracker,
            &pats(&[".cache"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        assert!(linked.is_empty());
        assert_eq!(
            without_symlinked(&linked, &pats(&[".cache"])),
            pats(&[".cache"])
        );
    }

    /// A link that WAS created suppresses the copy, which is the whole point of
    /// the precedence rule.
    #[test]
    fn a_created_link_suppresses_the_copy() {
        let (origin, worktree) = origin_and_worktree(".cache");
        let io = FakeIo::new();
        let linked = create_symlinks(
            &io,
            &FakeSymlinkCreator::new(),
            &NullTracker,
            &pats(&[".cache"]),
            origin.path().to_str().unwrap(),
            worktree.path().to_str().unwrap(),
            false,
        );
        assert!(
            without_symlinked(&linked, &pats(&[".cache", "node_modules"]))
                == pats(&["node_modules"])
        );
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
