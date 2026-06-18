//! Expand copy patterns (exact paths + globs) to repo-relative file/dir paths.
//!
//! Ported from `packages/core/src/utils/glob.ts`, but HARDENED against the
//! committed-symlink escape the TS implementation is vulnerable to (致命的 #4 in
//! the design review). The TS used `fast-glob` and only checked that the matched
//! *string* did not start with `..`; a symlink committed inside the repo that
//! points at `/etc/passwd` would still be matched and copied. Here:
//!
//! - the walk uses `WalkDir::follow_links(false)` (never traverse INTO symlinks),
//! - each matched entry is `symlink_metadata`'d and SKIPPED if it is a symlink
//!   (reject symlink entries outright), and
//! - every kept entry is `canonicalize`d and checked to be contained within the
//!   canonical repo root (`starts_with`); an entry that escapes is skipped+warned.
//!
//! Pattern validation also uses `Path::is_absolute()` (which rejects Windows
//! drive letters, not just a leading `/`), plus `..`-traversal and null-byte
//! rejection. All output paths are repo-root-relative and deduplicated, with
//! `onlyFiles` semantics for [`expand_copy_patterns`] and `onlyDirectories` for
//! [`expand_directory_patterns`].

use crate::io::Io;
use crate::output::warn_log;
use globset::{Glob, GlobMatcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// What kind of filesystem entries a pattern expansion keeps.
#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    Files,
    Directories,
}

/// True if `pattern` contains any glob metacharacter (`* ? [ ] {`).
///
/// Matches the TS `isGlobPattern` regex `/[*?[\]{]/`.
fn is_glob_pattern(pattern: &str) -> bool {
    pattern
        .chars()
        .any(|c| matches!(c, '*' | '?' | '[' | ']' | '{'))
}

/// Validate a pattern (for exact-path or glob use). Returns `false` (caller
/// skips + warns) on an absolute path, a `..` traversal, or a null byte.
///
/// SECURITY: `Path::is_absolute()` rejects `C:\...` / `\\server\share` on
/// Windows in addition to a leading `/`, unlike the TS `startsWith("/")`.
fn is_safe_pattern(pattern: &str) -> bool {
    if Path::new(pattern).is_absolute() {
        return false;
    }
    if pattern.contains('\0') {
        return false;
    }
    // Any `..` path component is a traversal attempt.
    if Path::new(pattern)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }
    true
}

/// Walk `repo_root` and collect repo-relative paths of `kind` matching `matcher`,
/// applying the symlink-entry rejection + canonical-containment guards.
fn walk_matches(
    io: &impl Io,
    matcher: &GlobMatcher,
    repo_root: &Path,
    canonical_root: &Path,
    kind: EntryKind,
    seen: &mut HashSet<String>,
    out: &mut Vec<String>,
) {
    // follow_links(false): never traverse INTO a symlinked directory (the walk
    // would otherwise descend through a committed symlink and enumerate files
    // outside the repo).
    for entry in WalkDir::new(repo_root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        // The root itself never matches a relative pattern.
        let Ok(rel) = path.strip_prefix(repo_root) else {
            continue;
        };
        if rel.as_os_str().is_empty() {
            continue;
        }

        let rel_str = rel.to_string_lossy().into_owned();
        if !matcher.is_match(rel) {
            continue;
        }

        // SECURITY: reject symlink ENTRIES (not just symlinked parents). A
        // committed symlink whose name matches the pattern must not be copied.
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            warn_log(io, &format!("Warning: Skipping symlink entry: {rel_str}"));
            continue;
        }

        // onlyFiles / onlyDirectories filter.
        let matches_kind = match kind {
            EntryKind::Files => meta.is_file(),
            EntryKind::Directories => meta.is_dir(),
        };
        if !matches_kind {
            continue;
        }

        // SECURITY: canonicalize and confirm containment within the repo root.
        // This is the fix for the committed-symlink → outside-repo leak.
        let Ok(canon) = std::fs::canonicalize(path) else {
            continue;
        };
        if !canon.starts_with(canonical_root) {
            warn_log(
                io,
                &format!("Warning: Skipping entry outside repository: {rel_str}"),
            );
            continue;
        }

        if seen.insert(rel_str.clone()) {
            out.push(rel_str);
        }
    }
}

/// Shared implementation for both file and directory pattern expansion.
fn expand(io: &impl Io, patterns: &[String], repo_root: &str, kind: EntryKind) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let root = PathBuf::from(repo_root);
    // The repo root is trusted; if it cannot be canonicalized, containment cannot
    // be enforced, so we expand nothing (fail closed).
    let Ok(canonical_root) = std::fs::canonicalize(&root) else {
        return out;
    };

    for pattern in patterns {
        if is_glob_pattern(pattern) {
            if !is_safe_pattern(pattern) {
                warn_log(io, &format!("Warning: Skipping invalid pattern: {pattern}"));
                continue;
            }
            let Ok(glob) = Glob::new(pattern) else {
                warn_log(
                    io,
                    &format!("Warning: Failed to compile glob pattern: {pattern}"),
                );
                continue;
            };
            walk_matches(
                io,
                &glob.compile_matcher(),
                &root,
                &canonical_root,
                kind,
                &mut seen,
                &mut out,
            );
            continue;
        }

        // Exact path.
        if !is_safe_pattern(pattern) {
            warn_log(io, &format!("Warning: Skipping invalid pattern: {pattern}"));
            continue;
        }

        match kind {
            EntryKind::Files => {
                // Files: the TS treated a non-glob exact pattern as a path to copy
                // VERBATIM without an existence/type check (copyFiles surfaces a
                // per-file error later). We keep that, but still apply the safety
                // checks above so absolute/`..`/null patterns never get through.
                if seen.insert(pattern.clone()) {
                    out.push(pattern.clone());
                }
            }
            EntryKind::Directories => {
                // Dirs: the TS verified the exact path is actually a directory
                // before keeping it. Enforce containment via symlink_metadata +
                // canonicalize too (a non-glob exact dir could still be a symlink).
                let abs = root.join(pattern);
                let Ok(meta) = std::fs::symlink_metadata(&abs) else {
                    continue;
                };
                if meta.file_type().is_symlink() {
                    warn_log(io, &format!("Warning: Skipping symlink entry: {pattern}"));
                    continue;
                }
                if !meta.is_dir() {
                    continue;
                }
                let Ok(canon) = std::fs::canonicalize(&abs) else {
                    continue;
                };
                if !canon.starts_with(&canonical_root) {
                    warn_log(
                        io,
                        &format!("Warning: Skipping entry outside repository: {pattern}"),
                    );
                    continue;
                }
                if seen.insert(pattern.clone()) {
                    out.push(pattern.clone());
                }
            }
        }
    }

    out
}

/// Expand file copy patterns (exact + glob) to repo-relative file paths.
pub fn expand_copy_patterns(io: &impl Io, patterns: &[String], repo_root: &str) -> Vec<String> {
    expand(io, patterns, repo_root, EntryKind::Files)
}

/// Expand directory copy patterns (exact + glob) to repo-relative dir paths.
pub fn expand_directory_patterns(
    io: &impl Io,
    patterns: &[String],
    repo_root: &str,
) -> Vec<String> {
    expand(io, patterns, repo_root, EntryKind::Directories)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::FakeIo;
    use vibe_test_support::Fixture;

    fn pats(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn is_glob_pattern_detects_metacharacters() {
        assert!(is_glob_pattern("*.env"));
        assert!(is_glob_pattern("config/*.txt"));
        assert!(is_glob_pattern("a[bc]"));
        assert!(is_glob_pattern("a{b,c}"));
        assert!(!is_glob_pattern(".env"));
        assert!(!is_glob_pattern("node_modules"));
    }

    #[test]
    fn exact_file_patterns_pass_through_deduped() {
        let fx = Fixture::new();
        let io = FakeIo::new();
        let files = expand_copy_patterns(
            &io,
            &pats(&[".env", ".env", "config.toml"]),
            fx.path().to_str().unwrap(),
        );
        assert_eq!(files, vec![".env".to_string(), "config.toml".to_string()]);
    }

    #[test]
    fn glob_files_expand_to_relative_paths() {
        let fx = Fixture::new();
        fx.write(".env", "a");
        fx.write(".env.local", "b");
        fx.write("src/main.rs", "c");
        let io = FakeIo::new();
        let mut files = expand_copy_patterns(&io, &pats(&[".env*"]), fx.path().to_str().unwrap());
        files.sort();
        assert_eq!(files, vec![".env".to_string(), ".env.local".to_string()]);
    }

    #[test]
    fn directory_exact_pattern_must_be_a_directory() {
        let fx = Fixture::new();
        fx.mkdir("node_modules");
        fx.write("not_a_dir", "x");
        let io = FakeIo::new();
        let dirs = expand_directory_patterns(
            &io,
            &pats(&["node_modules", "not_a_dir"]),
            fx.path().to_str().unwrap(),
        );
        // not_a_dir is a file → dropped; node_modules kept.
        assert_eq!(dirs, vec!["node_modules".to_string()]);
    }

    #[test]
    fn directory_glob_expands_only_directories() {
        let fx = Fixture::new();
        fx.mkdir(".cache/a");
        fx.mkdir(".cache/b");
        fx.write(".cache/file.txt", "x");
        let io = FakeIo::new();
        let mut dirs =
            expand_directory_patterns(&io, &pats(&[".cache/*"]), fx.path().to_str().unwrap());
        dirs.sort();
        assert_eq!(dirs, vec![".cache/a".to_string(), ".cache/b".to_string()]);
    }

    // --- SECURITY: 致命的 #4 symlink-walk-escape ---

    #[cfg(unix)]
    #[test]
    fn symlink_inside_repo_pointing_outside_is_not_expanded() {
        use std::os::unix::fs::symlink;
        // A repo with a committed symlink `leak` → an outside secret file.
        let outside = Fixture::new();
        let secret = outside.write("secret.txt", "TOP SECRET");

        let repo = Fixture::new();
        repo.write("normal.env", "ok");
        symlink(&secret, repo.join("leak")).unwrap();

        let io = FakeIo::new();
        // A glob that WOULD match the symlink by name must NOT expand it.
        let files = expand_copy_patterns(&io, &pats(&["*"]), repo.path().to_str().unwrap());
        assert!(
            files.contains(&"normal.env".to_string()),
            "real file should still be copied: {files:?}"
        );
        assert!(
            !files.contains(&"leak".to_string()),
            "committed symlink escaping the repo must be rejected: {files:?}"
        );
        assert!(
            io.stderr_text().contains("Skipping symlink entry"),
            "should warn about the rejected symlink: {}",
            io.stderr_text()
        );
    }

    /// G-15: a symlink whose target is INSIDE the repo root is ALSO skipped.
    ///
    /// DELIBERATE divergence from the TS fast-glob (which follows symlinks by
    /// default): the Rust hardening (#4) rejects ALL symlink ENTRIES outright,
    /// regardless of where they point — even a perfectly safe in-repo target. This
    /// locks that behavior so a future "relax for in-repo targets" change is a
    /// conscious decision, not an accident.
    #[cfg(unix)]
    #[test]
    fn symlink_with_in_repo_target_is_also_skipped() {
        use std::os::unix::fs::symlink;
        let repo = Fixture::new();
        // A real file inside the repo, and a symlink (also inside the repo) that
        // points at it. The target never escapes the repo.
        repo.write("real.env", "ok");
        symlink(repo.join("real.env"), repo.join("link.env")).unwrap();

        let io = FakeIo::new();
        let mut files = expand_copy_patterns(&io, &pats(&["*.env"]), repo.path().to_str().unwrap());
        files.sort();
        // The real file is copied; the in-repo-target symlink is STILL skipped.
        assert_eq!(
            files,
            vec!["real.env".to_string()],
            "symlink with an in-repo target must also be skipped (intentional vs TS): {files:?}"
        );
        assert!(
            io.stderr_text().contains("Skipping symlink entry"),
            "should warn about the rejected in-repo symlink: {}",
            io.stderr_text()
        );
    }

    #[cfg(unix)]
    #[test]
    fn exact_symlink_dir_pattern_is_rejected() {
        use std::os::unix::fs::symlink;
        let outside = Fixture::new();
        let target_dir = outside.mkdir("real_dir");

        let repo = Fixture::new();
        symlink(&target_dir, repo.join("linked_dir")).unwrap();

        let io = FakeIo::new();
        let dirs =
            expand_directory_patterns(&io, &pats(&["linked_dir"]), repo.path().to_str().unwrap());
        assert!(dirs.is_empty(), "symlinked dir must be rejected: {dirs:?}");
    }

    #[test]
    fn absolute_pattern_is_skipped_with_warning() {
        let fx = Fixture::new();
        let io = FakeIo::new();
        let files = expand_copy_patterns(&io, &pats(&["/etc/passwd"]), fx.path().to_str().unwrap());
        assert!(files.is_empty());
        assert!(io.stderr_text().contains("Skipping invalid pattern"));
    }

    #[test]
    fn parent_traversal_pattern_is_skipped() {
        let fx = Fixture::new();
        let io = FakeIo::new();
        let files =
            expand_copy_patterns(&io, &pats(&["../escape.txt"]), fx.path().to_str().unwrap());
        assert!(files.is_empty());
        assert!(io.stderr_text().contains("Skipping invalid pattern"));
    }

    #[test]
    fn null_byte_pattern_is_skipped() {
        let fx = Fixture::new();
        let io = FakeIo::new();
        let files = expand_copy_patterns(&io, &pats(&["bad\0name"]), fx.path().to_str().unwrap());
        assert!(files.is_empty());
    }

    #[test]
    fn absolute_glob_pattern_is_skipped() {
        let fx = Fixture::new();
        let io = FakeIo::new();
        // An absolute glob must be rejected too (defense vs `/etc/*`).
        let files = expand_copy_patterns(&io, &pats(&["/etc/*"]), fx.path().to_str().unwrap());
        assert!(files.is_empty());
        assert!(io.stderr_text().contains("Skipping invalid pattern"));
    }
}
