//! Collect extra copy candidates that git already knows about.
//!
//! `[copy] untracked` / `[copy] modified` (and the `--copy-untracked` /
//! `--copy-modified` CLI overrides) turn `git ls-files` output into the same
//! repo-relative file list that `[copy] files` produces, so both feed one
//! `copy_files` call.
//!
//! Enumeration goes through the `-z` (NUL-delimited) plumbing forms so a path
//! containing a newline, a space, or non-ASCII bytes survives verbatim: the
//! newline-delimited forms would split such a path in two, and without `-z` git
//! also octal-quotes non-ASCII names under the default `core.quotePath=true`.
//!
//! Every candidate then goes through the SAME hardening the glob expander
//! applies (`crate::glob`): absolute/`..`/NUL paths are rejected, symlink
//! entries are skipped, and each survivor is canonicalized and confirmed to be
//! contained in the canonical repo root. `git ls-files` never emits an absolute
//! or escaping path today, but the checks are the contract the copy layer
//! relies on — an untrusted `core.quotePath`/alternate-index setup must not be
//! able to widen what gets read out of the repository.
//!
//! A filename that is not valid UTF-8 cannot survive the `String` path seam this
//! crate uses end to end, so it is reported and skipped instead of being dropped
//! on the existence check. That verdict comes from decoding each NUL-delimited
//! record on its own (`git::split_nul` → `GitPathRecord`), so it is driven by the
//! actual bytes rather than by looking for U+FFFD in an already-lossy string.

use crate::config::VibeConfig;
use crate::error::Result;
use crate::git::{list_modified_files, list_untracked_files, GitPathRecord, GitRunner};
use crate::io::Io;
use crate::output::{sanitize_for_display, warn_log};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

/// Whether git-derived candidates are wanted, after CLI-over-config resolution.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GitCopySelection {
    pub untracked: bool,
    pub modified: bool,
}

impl GitCopySelection {
    /// True when neither source is enabled (so no `git ls-files` runs at all).
    pub fn is_empty(&self) -> bool {
        !self.untracked && !self.modified
    }
}

/// Resolve the selection from config plus CLI overrides.
///
/// The CLI flags are one-way opt-ins (`--copy-untracked` / `--copy-modified`):
/// passing one turns the source on even if config says `false`, while omitting
/// one leaves the config value alone. `--no-copy` is handled by the caller,
/// which never asks for a selection at all.
pub fn resolve_selection(
    config: Option<&VibeConfig>,
    cli_untracked: bool,
    cli_modified: bool,
) -> GitCopySelection {
    let copy = config.and_then(|c| c.copy.as_ref());
    GitCopySelection {
        untracked: cli_untracked || copy.and_then(|c| c.untracked).unwrap_or(false),
        modified: cli_modified || copy.and_then(|c| c.modified).unwrap_or(false),
    }
}

/// True if a git-reported path is safe to use as a copy source.
///
/// Mirrors `glob::is_safe_pattern`: no absolute path, no `..` component, no NUL.
fn is_safe_relative_path(path: &str) -> bool {
    if Path::new(path).is_absolute() {
        return false;
    }
    if path.contains('\0') {
        return false;
    }
    !Path::new(path)
        .components()
        .any(|c| matches!(c, Component::ParentDir))
}

/// Keep a candidate only if it is a real, contained, non-symlink regular file.
///
/// Why not TOCTOU-free: the symlink and containment verdicts are reached here,
/// but the open happens later in `CopyExecutor`, so someone who can write to the
/// repository between the two calls can swap a checked file for a symlink. The
/// window is not closed here because doing so means handing the executor an
/// already-open descriptor and re-checking with `fstat` — a change to the copy
/// seam that `glob::expand_copy_patterns` (which has the identical window for
/// `[copy] files`) would have to make at the same time, or the two sources would
/// disagree about what "checked" means. It is also not a privilege boundary:
/// `vibe start` runs as the user who already owns the repository, so an attacker
/// positioned to win the race can simply write the file's contents directly.
fn is_copyable_entry(io: &impl Io, repo_root: &Path, canonical_root: &Path, rel: &str) -> bool {
    let abs = repo_root.join(rel);
    // `--modified` also reports DELETED tracked files; those simply vanish here.
    let Ok(meta) = std::fs::symlink_metadata(&abs) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        warn_log(
            io,
            &format!(
                "Warning: Skipping symlink entry: {}",
                sanitize_for_display(rel)
            ),
        );
        return false;
    }
    if !meta.is_file() {
        return false;
    }
    let Ok(canon) = std::fs::canonicalize(&abs) else {
        return false;
    };
    if !canon.starts_with(canonical_root) {
        warn_log(
            io,
            &format!(
                "Warning: Skipping entry outside repository: {}",
                sanitize_for_display(rel)
            ),
        );
        return false;
    }
    true
}

/// Repo-relative files to copy for `selection`, in git's emitted order with
/// untracked entries first, deduplicated.
///
/// Returns an empty vec when nothing is selected. A `git ls-files` failure is
/// propagated so a broken repository surfaces rather than silently copying less.
pub fn collect_git_copy_files(
    io: &impl Io,
    git: &impl GitRunner,
    repo_root: &str,
    selection: GitCopySelection,
) -> Result<Vec<String>> {
    if selection.is_empty() {
        return Ok(Vec::new());
    }

    let root = PathBuf::from(repo_root);
    // Fail closed exactly like the glob expander: with no canonical root there is
    // no way to enforce containment, so nothing is collected.
    let Ok(canonical_root) = std::fs::canonicalize(&root) else {
        return Ok(Vec::new());
    };

    let mut candidates: Vec<GitPathRecord> = Vec::new();
    if selection.untracked {
        candidates.extend(list_untracked_files(git)?);
    }
    if selection.modified {
        candidates.extend(list_modified_files(git)?);
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for candidate in candidates {
        // A name that is not valid UTF-8 cannot be carried through this crate's
        // `String` path seam, so it is named in a warning rather than dropped
        // silently on the existence check below. It stays a warning rather than an
        // error because one unreadable name must not abort a copy of dozens of
        // good ones.
        let rel = match candidate {
            GitPathRecord::Valid(rel) => rel,
            GitPathRecord::Undecodable(lossy) => {
                warn_log(
                    io,
                    &format!(
                        "Warning: Skipping file whose name is not valid UTF-8: {}",
                        sanitize_for_display(&lossy)
                    ),
                );
                continue;
            }
        };
        if !is_safe_relative_path(&rel) {
            warn_log(
                io,
                &format!(
                    "Warning: Skipping invalid pattern: {}",
                    sanitize_for_display(&rel)
                ),
            );
            continue;
        }
        if !is_copyable_entry(io, &root, &canonical_root, &rel) {
            continue;
        }
        if seen.insert(rel.clone()) {
            out.push(rel);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CopyConfig;
    use crate::error::VibeError;
    use crate::io::FakeIo;
    use std::cell::RefCell;
    use vibe_test_support::Fixture;

    /// A git double that answers `ls-files` from canned NUL-delimited payloads
    /// and records the argv it was asked to run.
    ///
    /// Payloads are BYTES so a test can serve a filename that is genuinely not
    /// valid UTF-8 — the thing the production decode has to distinguish from a
    /// name that merely contains U+FFFD.
    struct LsFilesGit {
        untracked: Vec<u8>,
        modified: Vec<u8>,
        calls: RefCell<Vec<String>>,
        fail: bool,
    }

    impl LsFilesGit {
        fn new(untracked: &str, modified: &str) -> Self {
            Self::from_bytes(untracked.as_bytes(), modified.as_bytes())
        }
        fn from_bytes(untracked: &[u8], modified: &[u8]) -> Self {
            Self {
                untracked: untracked.to_vec(),
                modified: modified.to_vec(),
                calls: RefCell::new(Vec::new()),
                fail: false,
            }
        }
        fn failing() -> Self {
            Self {
                untracked: Vec::new(),
                modified: Vec::new(),
                calls: RefCell::new(Vec::new()),
                fail: true,
            }
        }
    }

    impl GitRunner for LsFilesGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            self.run_raw(args)
                .map(|out| String::from_utf8_lossy(&out).into_owned())
        }
        fn run_raw(&self, args: &[&str]) -> Result<Vec<u8>> {
            self.calls.borrow_mut().push(args.join(" "));
            if self.fail {
                return Err(VibeError::GitOperation {
                    command: args.join(" "),
                    message: "failed: not a git repository".into(),
                });
            }
            if args.contains(&"--others") {
                Ok(self.untracked.clone())
            } else {
                Ok(self.modified.clone())
            }
        }
    }

    fn config(untracked: Option<bool>, modified: Option<bool>) -> VibeConfig {
        VibeConfig {
            copy: Some(CopyConfig {
                untracked,
                modified,
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    // --- selection resolution ---

    #[test]
    fn both_sources_default_to_off() {
        assert_eq!(
            resolve_selection(None, false, false),
            GitCopySelection {
                untracked: false,
                modified: false
            }
        );
        assert!(resolve_selection(None, false, false).is_empty());
    }

    #[test]
    fn config_enables_each_source_independently() {
        let sel = resolve_selection(Some(&config(Some(true), Some(false))), false, false);
        assert!(sel.untracked);
        assert!(!sel.modified);
    }

    #[test]
    fn cli_flag_turns_a_source_on_despite_config_false() {
        let sel = resolve_selection(Some(&config(Some(false), Some(false))), true, false);
        assert!(sel.untracked, "--copy-untracked must override config false");
        assert!(!sel.modified);
    }

    // --- collection ---

    #[test]
    fn nothing_selected_runs_no_git_command() {
        let fx = Fixture::new();
        let io = FakeIo::new();
        let git = LsFilesGit::new("a\0", "b\0");
        let files = collect_git_copy_files(
            &io,
            &git,
            fx.path().to_str().unwrap(),
            GitCopySelection::default(),
        )
        .unwrap();
        assert!(files.is_empty());
        assert!(
            git.calls.borrow().is_empty(),
            "no ls-files call may be made when both toggles are off"
        );
    }

    #[test]
    fn untracked_files_are_collected_with_z_delimited_listing() {
        let fx = Fixture::new();
        fx.write("notes.txt", "x");
        let io = FakeIo::new();
        let git = LsFilesGit::new("notes.txt\0", "");
        let files = collect_git_copy_files(
            &io,
            &git,
            fx.path().to_str().unwrap(),
            GitCopySelection {
                untracked: true,
                modified: false,
            },
        )
        .unwrap();
        assert_eq!(files, vec!["notes.txt".to_string()]);
        let calls = git.calls.borrow();
        assert!(
            calls[0].contains("-z") && calls[0].contains("--exclude-standard"),
            "untracked enumeration must be NUL-delimited and honor gitignore: {calls:?}"
        );
    }

    #[test]
    fn spaced_and_non_ascii_names_survive_collection() {
        let fx = Fixture::new();
        fx.write("my file.txt", "x");
        fx.write("メモ.txt", "y");
        let io = FakeIo::new();
        let git = LsFilesGit::new("my file.txt\0メモ.txt\0", "");
        let mut files = collect_git_copy_files(
            &io,
            &git,
            fx.path().to_str().unwrap(),
            GitCopySelection {
                untracked: true,
                modified: false,
            },
        )
        .unwrap();
        files.sort();
        assert_eq!(
            files,
            vec!["my file.txt".to_string(), "メモ.txt".to_string()]
        );
    }

    #[test]
    fn untracked_and_modified_are_merged_and_deduplicated() {
        let fx = Fixture::new();
        fx.write("new.txt", "x");
        fx.write("changed.rs", "y");
        let io = FakeIo::new();
        // The same path reported by both listings must be copied once.
        let git = LsFilesGit::new("new.txt\0changed.rs\0", "changed.rs\0");
        let files = collect_git_copy_files(
            &io,
            &git,
            fx.path().to_str().unwrap(),
            GitCopySelection {
                untracked: true,
                modified: true,
            },
        )
        .unwrap();
        assert_eq!(
            files,
            vec!["new.txt".to_string(), "changed.rs".to_string()],
            "duplicates across the two listings collapse to one entry"
        );
    }

    #[test]
    fn deleted_modified_entries_are_dropped() {
        let fx = Fixture::new();
        fx.write("still_here.rs", "x");
        let io = FakeIo::new();
        // `--modified` reports deletions too; `gone.rs` no longer exists on disk.
        let git = LsFilesGit::new("", "still_here.rs\0gone.rs\0");
        let files = collect_git_copy_files(
            &io,
            &git,
            fx.path().to_str().unwrap(),
            GitCopySelection {
                untracked: false,
                modified: true,
            },
        )
        .unwrap();
        assert_eq!(files, vec!["still_here.rs".to_string()]);
    }

    #[test]
    fn directories_reported_by_git_are_not_copied_as_files() {
        let fx = Fixture::new();
        fx.mkdir("scratch");
        let io = FakeIo::new();
        let git = LsFilesGit::new("scratch\0", "");
        let files = collect_git_copy_files(
            &io,
            &git,
            fx.path().to_str().unwrap(),
            GitCopySelection {
                untracked: true,
                modified: false,
            },
        )
        .unwrap();
        assert!(files.is_empty(), "a directory entry is not a copyable file");
    }

    #[test]
    fn absolute_and_traversing_paths_are_rejected() {
        let fx = Fixture::new();
        let io = FakeIo::new();
        let absolute = vibe_test_support::fake_root_str("etc/passwd");
        let git = LsFilesGit::new(&format!("{absolute}\0../escape.txt\0"), "");
        let files = collect_git_copy_files(
            &io,
            &git,
            fx.path().to_str().unwrap(),
            GitCopySelection {
                untracked: true,
                modified: false,
            },
        )
        .unwrap();
        assert!(files.is_empty(), "unsafe git-reported paths: {files:?}");
        assert!(io.stderr_text().contains("Skipping invalid pattern"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_entries_are_skipped() {
        use std::os::unix::fs::symlink;
        let outside = Fixture::new();
        let secret = outside.write("secret.txt", "TOP SECRET");
        let fx = Fixture::new();
        fx.write("real.txt", "ok");
        symlink(&secret, fx.join("leak")).unwrap();

        let io = FakeIo::new();
        let git = LsFilesGit::new("real.txt\0leak\0", "");
        let files = collect_git_copy_files(
            &io,
            &git,
            fx.path().to_str().unwrap(),
            GitCopySelection {
                untracked: true,
                modified: false,
            },
        )
        .unwrap();
        assert_eq!(files, vec!["real.txt".to_string()]);
        assert!(io.stderr_text().contains("Skipping symlink entry"));
    }

    #[test]
    fn non_utf8_names_are_reported_rather_than_dropped_silently() {
        // A filename carrying invalid UTF-8 bytes cannot cross this crate's
        // `String` path seam and matches nothing on disk. It must be named in a
        // warning, not vanish on the existence check.
        let fx = Fixture::new();
        fx.write("good.txt", "x");
        let io = FakeIo::new();
        // 0xFF is never valid UTF-8 anywhere in a sequence.
        let mut payload = b"good.txt\0bad".to_vec();
        payload.push(0xff);
        payload.extend_from_slice(b"name.txt\0");
        let git = LsFilesGit::from_bytes(&payload, b"");
        let files = collect_git_copy_files(
            &io,
            &git,
            fx.path().to_str().unwrap(),
            GitCopySelection {
                untracked: true,
                modified: false,
            },
        )
        .unwrap();
        assert_eq!(
            files,
            vec!["good.txt".to_string()],
            "the decodable file is still copied"
        );
        assert!(
            io.stderr_text().contains("is not valid UTF-8"),
            "{}",
            io.stderr_text()
        );
    }

    #[test]
    fn a_filename_genuinely_containing_u_fffd_is_still_copied() {
        // U+FFFD is a legal filename character. Because each NUL-delimited record
        // is decoded on its own, such a name decodes cleanly and must be treated
        // as an ordinary file — not mistaken for the lossy rendering of invalid
        // bytes and silently excluded.
        let fx = Fixture::new();
        let legit = "report\u{fffd}v2.txt";
        fx.write(legit, "x");
        let io = FakeIo::new();
        let git = LsFilesGit::new(&format!("{legit}\0"), "");
        let files = collect_git_copy_files(
            &io,
            &git,
            fx.path().to_str().unwrap(),
            GitCopySelection {
                untracked: true,
                modified: false,
            },
        )
        .unwrap();
        assert_eq!(files, vec![legit.to_string()]);
        assert!(
            !io.stderr_text().contains("is not valid UTF-8"),
            "a decodable name must not be reported as undecodable: {}",
            io.stderr_text()
        );
    }

    #[test]
    fn skip_warnings_neutralize_control_characters_in_names() {
        // The rejected path is printed back to the user, and its bytes came from a
        // filename in the repository. An ESC or bidi override in it must not be
        // able to rewrite the terminal around the warning.
        let fx = Fixture::new();
        let io = FakeIo::new();
        let git = LsFilesGit::new("../esc\u{1b}[2K\u{202e}ape.txt\0", "");
        let files = collect_git_copy_files(
            &io,
            &git,
            fx.path().to_str().unwrap(),
            GitCopySelection {
                untracked: true,
                modified: false,
            },
        )
        .unwrap();
        assert!(files.is_empty());
        let out = io.stderr_text();
        assert!(
            !out.contains('\u{1b}') && !out.contains('\u{202e}'),
            "control characters reached the terminal: {out:?}"
        );
        assert!(out.contains("esc\u{fffd}[2K\u{fffd}ape.txt"), "{out:?}");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_skip_warning_neutralizes_control_characters() {
        use std::os::unix::fs::symlink;
        let outside = Fixture::new();
        let secret = outside.write("secret.txt", "TOP SECRET");
        let fx = Fixture::new();
        let nasty = "link\u{1b}[2Kname";
        symlink(&secret, fx.join(nasty)).unwrap();

        let io = FakeIo::new();
        let git = LsFilesGit::new(&format!("{nasty}\0"), "");
        let files = collect_git_copy_files(
            &io,
            &git,
            fx.path().to_str().unwrap(),
            GitCopySelection {
                untracked: true,
                modified: false,
            },
        )
        .unwrap();
        assert!(files.is_empty());
        let out = io.stderr_text();
        assert!(!out.contains('\u{1b}'), "{out:?}");
        assert!(
            out.contains("Skipping symlink entry: link\u{fffd}[2Kname"),
            "{out:?}"
        );
    }

    #[test]
    fn git_failure_propagates() {
        let fx = Fixture::new();
        let io = FakeIo::new();
        let git = LsFilesGit::failing();
        let err = collect_git_copy_files(
            &io,
            &git,
            fx.path().to_str().unwrap(),
            GitCopySelection {
                untracked: true,
                modified: false,
            },
        )
        .unwrap_err();
        assert!(matches!(err, VibeError::GitOperation { .. }));
    }
}
