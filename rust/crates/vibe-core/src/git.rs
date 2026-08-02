//! Git operations and porcelain parsing.
//!
//! Ported from `packages/core/src/utils/git.ts`. The original threaded an
//! `AppContext` so tests could mock `process.run`/`fs`; here a [`GitRunner`]
//! trait plays that role. Pure helpers (`sanitize_branch_name`,
//! `normalize_remote_url`, worktree-list parsing) take no runner and are tested
//! directly. [`RealGit`] is the production runner over `std::process::Command`.

use crate::error::{Result, VibeError};
use std::path::Path;
use std::process::Command;

/// A single worktree entry parsed from `git worktree list --porcelain [-z]`.
///
/// `branch` is `None` for a detached-HEAD worktree: git emits a bare `detached`
/// line instead of `branch refs/heads/…` for those, and they are real worktrees
/// a user can be standing in, so they must be representable rather than dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
}

/// Repository information extracted from a file path.
///
/// Ported from the `RepoInfo` interface in git.ts. Used by the trust store to
/// identify which repository a `.vibe.toml` belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoInfo {
    pub remote_url: Option<String>,
    pub repo_root: String,
    pub relative_path: String,
}

/// Abstraction over running `git`, so command-driven logic is unit-testable.
///
/// Mirrors the role of the mocked `process.run` in the TS tests. `run` returns
/// trimmed stdout on success and a [`VibeError::GitOperation`] on failure.
pub trait GitRunner {
    fn run(&self, args: &[&str]) -> Result<String>;
}

/// Environment pinned on every `git` invocation, forcing the C locale.
///
/// `is_unsupported_option_error` decides the `-z` fallback by matching git's
/// English diagnostic text, and git translates its messages: under `ja_JP.UTF-8`
/// a pre-2.36 git answers `-z` with a translated "unknown option", the match
/// fails, and every worktree-enumerating command breaks instead of degrading.
///
/// Pinned here — on the one place a `git` process is constructed — rather than
/// only on the probe invocation: the [`GitRunner`] seam takes just an argument
/// vector, so a probe-only override would mean widening the trait or bypassing
/// it for one call, and there is nothing to protect on the other callers. Every
/// other invocation reads machine-stable output (`--porcelain`, `rev-parse`,
/// `config --get`), which git does not translate, so the C locale changes
/// nothing for them.
///
/// `LC_ALL` alone is not enough: `LANGUAGE` overrides it for message
/// translation in gettext, so both must be set.
const GIT_C_LOCALE_ENV: [(&str, &str); 2] = [("LC_ALL", "C"), ("LANGUAGE", "C")];

/// Production [`GitRunner`] that shells out to the real `git` binary.
pub struct RealGit;

impl GitRunner for RealGit {
    fn run(&self, args: &[&str]) -> Result<String> {
        let output = Command::new("git")
            .args(args)
            .envs(GIT_C_LOCALE_ENV)
            .output()
            .map_err(|e| VibeError::GitOperation {
                command: args.join(" "),
                message: e.to_string(),
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Matches the TS message: `git <args> failed: <stderr>`.
            return Err(VibeError::GitOperation {
                command: args.join(" "),
                message: format!("failed: {}", stderr.trim()),
            });
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
}

/// Replace `/` with `-` in a branch name (for default worktree dir names).
pub fn sanitize_branch_name(branch_name: &str) -> String {
    branch_name.replace('/', "-")
}

/// The preferred argument vector for reading the worktree list.
///
/// `-z` (NUL-terminated records) rather than plain `--porcelain`: a worktree
/// path may legally contain a literal newline, and the line-oriented format has
/// no way to express that — git's own docs recommend `-z` for machine
/// consumption for exactly this reason.
const WORKTREE_LIST_ARGS_Z: [&str; 4] = ["worktree", "list", "--porcelain", "-z"];

/// The compatibility argument vector, used when `git` rejects `-z`.
///
/// `git worktree list` only learned `-z` in 2.36, and some LTS distributions
/// still ship an older git. Dropping `-z` there costs only the newline-in-path
/// edge case (which the line-oriented format simply cannot express) instead of
/// breaking every worktree-enumerating command — `list`, `start`, `clean`,
/// `home` and `jump` all read through here.
const WORKTREE_LIST_ARGS_PLAIN: [&str; 3] = ["worktree", "list", "--porcelain"];

/// Read the raw worktree-list payload, preferring `-z` and degrading if unsupported.
///
/// Probing by *attempting* `-z` rather than parsing `git --version` first: the
/// version string is not a reliable capability oracle (distributions backport,
/// and vendored builds carry non-semver versions), and the happy path stays a
/// single `git` invocation — the extra call only happens on the git that cannot
/// serve the first one.
///
/// Only an argument-parsing rejection triggers the retry. A genuine failure —
/// "not a git repository", a broken repo — must surface as itself rather than
/// being retried and reported under the fallback command, which would hide the
/// real cause behind a second identical error.
fn run_worktree_list(runner: &impl GitRunner) -> Result<String> {
    match runner.run(&WORKTREE_LIST_ARGS_Z) {
        Ok(output) => Ok(output),
        Err(err) if is_unsupported_option_error(&err) => runner.run(&WORKTREE_LIST_ARGS_PLAIN),
        Err(err) => Err(err),
    }
}

/// True when a git failure is "you passed an option I do not know".
///
/// git prints `error: unknown option ...` (and/or a `usage: git worktree list`
/// synopsis) on an unparsed flag, versus `fatal: ...` for operational failures,
/// so matching those markers separates "this git is too old" from "this repo is
/// broken". Matching on the message rather than the exit status because git uses
/// 129 for usage errors only on some paths, and the [`GitRunner`] abstraction
/// intentionally carries the message, not the raw status.
///
/// The markers are git's untranslated English wording, which is only what
/// [`RealGit`] sees because it pins [`GIT_C_LOCALE_ENV`]; without that pinning
/// this predicate would silently stop matching under a non-English locale.
fn is_unsupported_option_error(err: &VibeError) -> bool {
    let VibeError::GitOperation { message, .. } = err else {
        return false;
    };
    let message = message.to_ascii_lowercase();
    message.contains("unknown option")
        || message.contains("unknown switch")
        || message.contains("usage: git worktree list")
}

/// Parse `git worktree list --porcelain [-z]` output into ordered worktree
/// entries.
///
/// git emits entries in a stable order (main worktree first), so we preserve
/// the emitted order rather than re-sorting — and we never depend on
/// nondeterministic filesystem `read_dir` order anywhere.
///
/// The record separator is detected from the payload — see
/// [`split_worktree_records`] — so both the `-z` output we ask git for first and
/// the plain line-oriented porcelain we fall back to on a pre-2.36 git parse
/// identically. That is what lets a path containing a newline survive: under
/// `-z` the newline is interior to a record rather than a record separator.
///
/// An entry is accumulated from its `worktree <path>` record and flushed when
/// the next one starts (or at EOF), so a detached-HEAD worktree — which carries
/// a bare `detached` record and NO `branch` record — yields `branch: None`
/// instead of vanishing. A `bare` entry is dropped: a bare repository has no
/// working tree to stand in or `cd` to, so it is not a worktree for any of our
/// purposes.
pub fn parse_worktree_list(output: &str) -> Vec<Worktree> {
    let mut worktrees = Vec::new();
    let mut current: Option<Worktree> = None;
    let mut is_bare = false;

    // Push the entry accumulated so far, unless it is a bare repository.
    fn flush(out: &mut Vec<Worktree>, current: Option<Worktree>, is_bare: bool) {
        if let Some(wt) = current {
            if !is_bare {
                out.push(wt);
            }
        }
    }

    for line in split_worktree_records(output) {
        if let Some(rest) = line.strip_prefix("worktree ") {
            flush(&mut worktrees, current.take(), is_bare);
            is_bare = false;
            current = Some(Worktree {
                path: rest.to_string(),
                branch: None,
            });
        } else if let Some(rest) = line.strip_prefix("branch refs/heads/") {
            if let Some(wt) = current.as_mut() {
                wt.branch = Some(rest.to_string());
            }
        } else if line.trim() == "bare" {
            is_bare = true;
        }
    }
    flush(&mut worktrees, current.take(), is_bare);

    worktrees
}

/// Split worktree-list output into records, picking the separator from the data.
///
/// `-z` output is NUL-terminated and, by construction, uses `\n` for nothing but
/// bytes that are genuinely part of a path; plain `--porcelain` output is
/// newline-separated and contains no `\0` at all. So the presence of a single
/// `\0` is an unambiguous discriminator, and keying off it — rather than
/// splitting on both bytes — is what preserves a newline inside a path.
///
/// Not simply "always `-z`": the plain branch is what a git older than 2.36
/// produces after [`run_worktree_list`] retries without `-z`, and it is also
/// what the hand-written line-oriented fixtures use. Keeping one parser for both
/// beats maintaining two that can drift apart.
fn split_worktree_records(output: &str) -> impl Iterator<Item = &str> {
    let separator = if output.contains('\0') { '\0' } else { '\n' };
    output.split(separator)
}

/// Normalize a git remote URL to a canonical `host/user/repo` form.
///
/// Direct port of `normalizeRemoteUrl`: strip trailing `.git`, convert
/// `git@host:path` to `host/path`, strip the protocol, then strip credentials.
pub fn normalize_remote_url(url: &str) -> String {
    let mut normalized = url.trim().to_string();

    // Remove trailing `.git`.
    if let Some(stripped) = normalized.strip_suffix(".git") {
        normalized = stripped.to_string();
    }

    // Convert SSH `git@host:` prefix to `host/`.
    normalized = convert_scp_prefix(&normalized);

    // Remove protocol (`https://`, `http://`, `ssh://`, ...).
    normalized = strip_protocol(&normalized);

    // Remove leading credentials (`user@` or `user:pass@`) up to the first `@`.
    if let Some(at) = normalized.find('@') {
        normalized = normalized[at + 1..].to_string();
    }

    normalized
}

/// Convert a leading `git@host:` (scp-like) prefix to `host/`.
///
/// Matches the TS regex `^git@([^:]+):` → `$1/`.
fn convert_scp_prefix(s: &str) -> String {
    let Some(rest) = s.strip_prefix("git@") else {
        return s.to_string();
    };
    let Some(colon) = rest.find(':') else {
        return s.to_string();
    };
    let host = &rest[..colon];
    // `[^:]+` means the host portion must not contain a colon, which holds here
    // since we split on the first colon.
    format!("{host}/{}", &rest[colon + 1..])
}

/// Strip a leading `<scheme>://` where scheme is lowercase letters.
///
/// Matches the TS regex `^[a-z]+:\/\/`.
fn strip_protocol(s: &str) -> String {
    let Some(idx) = s.find("://") else {
        return s.to_string();
    };
    let scheme = &s[..idx];
    if !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_lowercase()) {
        s[idx + 3..].to_string()
    } else {
        s.to_string()
    }
}

/// Find the worktree path using `branch_name`, or `None`.
pub fn find_worktree_by_branch(
    runner: &impl GitRunner,
    branch_name: &str,
) -> Result<Option<String>> {
    let output = run_worktree_list(runner)?;
    let worktrees = parse_worktree_list(&output);
    Ok(worktrees
        .into_iter()
        .find(|w| w.branch.as_deref() == Some(branch_name))
        .map(|w| w.path))
}

/// Find the worktree whose path lexically normalizes to `path`, or `None`.
///
/// Ported from `getWorktreeByPath`. Matching is LEXICAL (node `path.normalize`):
/// it folds `.`/`..`/duplicate separators textually but does NOT touch the
/// filesystem or resolve symlinks. We deliberately do NOT `canonicalize` here so
/// the result matches the TS even when the directory has just been moved out from
/// under us (e.g. mid-rename) — a `canonicalize` would fail on a vanished path.
pub fn get_worktree_by_path(runner: &impl GitRunner, path: &str) -> Result<Option<Worktree>> {
    let worktrees = get_worktree_list(runner)?;
    let target = lexical_normalize_path(path);
    Ok(worktrees
        .into_iter()
        .find(|w| lexical_normalize_path(&w.path) == target))
}

/// Lexically fold a path (`.`/`..`/redundant separators) WITHOUT filesystem
/// access, approximating node's `path.normalize` closely enough for worktree
/// path equality. `Path::components` already drops `.` and collapses separators;
/// we additionally pop on `..` to fold parent traversals.
pub fn lexical_normalize_path(path: &str) -> String {
    use std::path::Component;
    let mut stack: Vec<std::ffi::OsString> = Vec::new();
    let mut prefix = String::new();
    let mut is_absolute = false;
    for comp in Path::new(path).components() {
        match comp {
            Component::Prefix(p) => prefix = p.as_os_str().to_string_lossy().into_owned(),
            Component::RootDir => is_absolute = true,
            Component::CurDir => {}
            Component::ParentDir => {
                // Pop a normal segment if present; otherwise keep `..` (it can
                // only stay when the path is relative and has no parent to fold).
                let can_pop = stack
                    .last()
                    .map(|s| s != std::ffi::OsStr::new(".."))
                    .unwrap_or(false);
                if can_pop {
                    stack.pop();
                } else if !is_absolute {
                    stack.push(std::ffi::OsString::from(".."));
                }
            }
            Component::Normal(seg) => stack.push(seg.to_os_string()),
        }
    }
    let joined = stack
        .iter()
        .map(|s| s.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    let body = if is_absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    };
    format!("{prefix}{body}")
}

/// `git rev-parse --show-toplevel`.
pub fn get_repo_root(runner: &impl GitRunner) -> Result<String> {
    runner.run(&["rev-parse", "--show-toplevel"])
}

/// The repository name: the basename of the repo root (TS `getRepoName`).
pub fn get_repo_name(runner: &impl GitRunner) -> Result<String> {
    let root = get_repo_root(runner)?;
    Ok(std::path::Path::new(&root)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or(root))
}

/// True if `ref` resolves (`git rev-parse --verify --quiet <ref>`). Any failure
/// → `false` (TS `revisionExists` try/catch).
pub fn revision_exists(runner: &impl GitRunner, reference: &str) -> bool {
    runner
        .run(&["rev-parse", "--verify", "--quiet", reference])
        .is_ok()
}

/// True if `refs/remotes/<remote>/<branch>` exists (TS `remoteBranchExists`).
pub fn remote_branch_exists(runner: &impl GitRunner, branch_name: &str, remote: &str) -> bool {
    runner
        .run(&[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{remote}/{branch_name}"),
        ])
        .is_ok()
}

/// All worktrees from `git worktree list --porcelain [-z]`, in git's emitted order.
pub fn get_worktree_list(runner: &impl GitRunner) -> Result<Vec<Worktree>> {
    let output = run_worktree_list(runner)?;
    Ok(parse_worktree_list(&output))
}

/// True iff `git rev-parse --is-inside-work-tree` prints `true`.
///
/// Any git failure (not a repo) maps to `false`, matching the TS try/catch.
pub fn is_inside_worktree(runner: &impl GitRunner) -> bool {
    runner
        .run(&["rev-parse", "--is-inside-work-tree"])
        .map(|out| out == "true")
        .unwrap_or(false)
}

/// The main worktree's path: the first entry of `git worktree list`.
///
/// Errors if no worktree is listed (TS threw "Could not find main worktree").
pub fn get_main_worktree_path(runner: &impl GitRunner) -> Result<String> {
    let worktrees = get_worktree_list(runner)?;
    worktrees
        .into_iter()
        .next()
        .map(|w| w.path)
        .ok_or_else(|| VibeError::Worktree("Could not find main worktree".to_string()))
}

/// Whether the current repo root is the main worktree.
pub fn is_main_worktree(runner: &impl GitRunner) -> Result<bool> {
    let current_root = get_repo_root(runner)?;
    let main_path = get_main_worktree_path(runner)?;
    Ok(current_root == main_path)
}

/// True if `git status --porcelain` reports any change (or untracked file).
pub fn has_uncommitted_changes(runner: &impl GitRunner) -> Result<bool> {
    let output = runner.run(&["status", "--porcelain"])?;
    Ok(!output.trim().is_empty())
}

/// True if `refs/heads/<branch>` exists locally.
pub fn branch_exists(runner: &impl GitRunner, branch_name: &str) -> bool {
    runner
        .run(&[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch_name}"),
        ])
        .is_ok()
}

/// Last-resort default-branch name when git tells us nothing.
///
/// `master` (not `main`): it is what git itself still falls back to when
/// `init.defaultBranch` is unset, so a repository that gives us no signal at all
/// is most likely an old-style one.
const FALLBACK_DEFAULT_BRANCH: &str = "master";

/// Resolve the repository's default branch NAME (no `origin/` prefix).
///
/// Resolution order, first hit wins:
/// 1. `git symbolic-ref refs/remotes/origin/HEAD --short` → `origin/<name>`,
///    the authoritative answer for a cloned repo.
/// 2. `git config --get init.defaultBranch` → what a fresh `git init` here would
///    have created (covers repos with no remote).
/// 3. [`FALLBACK_DEFAULT_BRANCH`].
///
/// Never fails: every git call is best-effort, because this feeds a *guard*, and
/// a guard that errors out would break `clean`/`rename` in repositories where
/// git simply has no opinion.
pub fn get_default_branch(runner: &impl GitRunner) -> String {
    if let Ok(out) = runner.run(&["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]) {
        if let Some(name) = strip_remote_prefix(out.trim()) {
            return name;
        }
    }

    if let Ok(out) = runner.run(&["config", "--get", "init.defaultBranch"]) {
        let trimmed = out.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    FALLBACK_DEFAULT_BRANCH.to_string()
}

/// Strip the leading `origin/` from a `symbolic-ref --short` answer.
///
/// Returns `None` for an empty input or a bare `origin/` with nothing after it,
/// so the caller falls through to the next resolution step instead of adopting
/// an empty branch name (which would make the guard match every branch).
fn strip_remote_prefix(short_ref: &str) -> Option<String> {
    let name = short_ref.strip_prefix("origin/").unwrap_or(short_ref);
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Result of [`detect_broken_worktree_link`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BrokenWorktreeLink {
    pub is_broken: bool,
    pub git_dir: Option<String>,
    pub main_worktree_path: Option<String>,
}

/// Detect a secondary worktree whose main worktree (and thus `.git` gitdir
/// target) has been deleted, leaving a dangling `.git` file.
///
/// Ported from `detectBrokenWorktreeLink`. `cwd` is passed in (the TS read it
/// from the runtime) so this stays a pure function over the filesystem.
pub fn detect_broken_worktree_link(cwd: &Path) -> BrokenWorktreeLink {
    let not_broken = BrokenWorktreeLink::default();
    let git_path = cwd.join(".git");

    let Ok(meta) = std::fs::symlink_metadata(&git_path) else {
        return not_broken;
    };

    // A main worktree has a `.git` directory; only a `.git` *file* can dangle.
    if meta.is_dir() {
        return not_broken;
    }

    let Ok(content) = std::fs::read_to_string(&git_path) else {
        return not_broken;
    };

    // Parse `gitdir: <path>` (TS regex `^gitdir:\s*(.+)$` on the trimmed text).
    let Some(git_dir) = parse_gitdir(content.trim()) else {
        return not_broken;
    };

    // If the referenced gitdir still exists, the link is fine.
    if Path::new(&git_dir).exists() {
        return not_broken;
    }

    // gitdir is `<main>/.git/worktrees/<name>`; three parents up is `<main>`.
    let main_worktree_path = Path::new(&git_dir)
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(|p| p.to_string_lossy().to_string());

    BrokenWorktreeLink {
        is_broken: true,
        git_dir: Some(git_dir),
        main_worktree_path,
    }
}

/// Extract the path from a `gitdir: <path>` line.
fn parse_gitdir(trimmed: &str) -> Option<String> {
    let rest = trimmed.strip_prefix("gitdir:")?;
    let path = rest.trim_start();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scripted runner: returns a fixed response for the worktree-list call.
    struct MockGit {
        worktree_list: String,
    }
    impl GitRunner for MockGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            if args.contains(&"worktree") && args.contains(&"list") {
                Ok(self.worktree_list.clone())
            } else {
                Ok(String::new())
            }
        }
    }

    /// A runner emulating a git that rejects `-z`, recording every invocation.
    ///
    /// `stderr_for_z` is the message such a git puts on stderr, so a test can
    /// pin the exact wording an old git produces.
    struct OldGit {
        stderr_for_z: String,
        plain_output: String,
        calls: std::cell::RefCell<Vec<Vec<String>>>,
    }
    impl OldGit {
        fn new(stderr_for_z: &str, plain_output: &str) -> Self {
            Self {
                stderr_for_z: stderr_for_z.to_string(),
                plain_output: plain_output.to_string(),
                calls: std::cell::RefCell::new(Vec::new()),
            }
        }
        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.borrow().clone()
        }
    }
    impl GitRunner for OldGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            self.calls
                .borrow_mut()
                .push(args.iter().map(|a| a.to_string()).collect());
            if args.contains(&"-z") {
                return Err(VibeError::GitOperation {
                    command: args.join(" "),
                    message: format!("failed: {}", self.stderr_for_z),
                });
            }
            Ok(self.plain_output.clone())
        }
    }

    /// A runner whose worktree listing always fails with `message`.
    struct FailingGit {
        message: String,
        calls: std::cell::RefCell<usize>,
    }
    impl GitRunner for FailingGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            *self.calls.borrow_mut() += 1;
            Err(VibeError::GitOperation {
                command: args.join(" "),
                message: self.message.clone(),
            })
        }
    }

    const PLAIN_LIST: &str = "worktree /repo/main\nHEAD aaaa\nbranch refs/heads/main\n\nworktree /repo/feat\nHEAD bbbb\nbranch refs/heads/feature\n\n";

    #[test]
    fn worktree_list_prefers_z_and_does_not_retry_when_it_works() {
        // The modern path must stay a single git invocation.
        let git = MockGit {
            worktree_list: "worktree /repo/main\0branch refs/heads/main\0\0".to_string(),
        };
        assert_eq!(
            get_worktree_list(&git).unwrap(),
            vec![Worktree {
                path: "/repo/main".into(),
                branch: Some("main".into()),
            }]
        );
    }

    #[test]
    fn worktree_list_falls_back_to_plain_porcelain_when_z_is_rejected() {
        // A git older than 2.36 rejects `-z`; the listing must still be read
        // rather than every worktree command failing outright.
        let git = OldGit::new("error: unknown option `z'", PLAIN_LIST);
        assert_eq!(
            get_worktree_list(&git).unwrap(),
            vec![
                Worktree {
                    path: "/repo/main".into(),
                    branch: Some("main".into()),
                },
                Worktree {
                    path: "/repo/feat".into(),
                    branch: Some("feature".into()),
                },
            ]
        );
        assert_eq!(
            git.calls(),
            vec![
                vec!["worktree", "list", "--porcelain", "-z"],
                vec!["worktree", "list", "--porcelain"],
            ],
            "the fallback must retry without -z, and only after -z was rejected"
        );
    }

    #[test]
    fn real_git_runs_git_under_the_c_locale() {
        // What it guarantees: the `-z` fallback probe keeps working on a
        // non-English system. `is_unsupported_option_error` matches git's
        // English diagnostics, so `RealGit` must force the C locale onto the
        // child regardless of the ambient environment — otherwise a pre-2.36
        // git under e.g. ja_JP.UTF-8 answers with a translated "unknown option"
        // and the fallback never fires.
        //
        // Asserted by making git echo the locale variables it was launched
        // with, rather than by comparing translated output: whether any given
        // machine has git's translations installed is not something a test can
        // rely on, so a message-text assertion would silently pass everywhere.
        let ambient = [("LC_ALL", "ja_JP.UTF-8"), ("LANGUAGE", "ja")];
        let output = Command::new("git")
            .args([
                "-c",
                "alias.vibeshowlocale=!printf '%s|%s' \"$LC_ALL\" \"$LANGUAGE\"",
                "vibeshowlocale",
            ])
            .envs(ambient)
            .envs(GIT_C_LOCALE_ENV)
            .output()
            .expect("git must be runnable in the test environment");

        assert!(
            output.status.success(),
            "probe alias failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "C|C",
            "RealGit's pinned env must override an ambient non-English locale"
        );
    }

    #[test]
    fn c_locale_pinning_covers_both_gettext_variables() {
        // What it guarantees: LC_ALL alone is insufficient — gettext lets
        // LANGUAGE override it for message translation, so dropping LANGUAGE
        // would reintroduce the translated-diagnostic bug on systems that set
        // it.
        let pinned: std::collections::HashMap<_, _> = GIT_C_LOCALE_ENV.into_iter().collect();
        assert_eq!(pinned.get("LC_ALL"), Some(&"C"));
        assert_eq!(pinned.get("LANGUAGE"), Some(&"C"));
    }

    #[test]
    fn unsupported_option_match_is_case_insensitive_over_git_wordings() {
        // What it guarantees: the marker set covers the wordings git actually
        // emits for an unparsed flag, in the C locale the runner pins.
        for message in [
            "failed: error: unknown option `z'",
            "failed: error: unknown switch `z'",
            "failed: usage: git worktree list [-v | --porcelain [-z]]",
            "failed: ERROR: Unknown Option `z'",
        ] {
            let err = VibeError::GitOperation {
                command: "worktree list --porcelain -z".to_string(),
                message: message.to_string(),
            };
            assert!(
                is_unsupported_option_error(&err),
                "must be treated as an unsupported-option rejection: {message}"
            );
        }

        let genuine = VibeError::GitOperation {
            command: "worktree list --porcelain -z".to_string(),
            message: "failed: fatal: not a git repository".to_string(),
        };
        assert!(!is_unsupported_option_error(&genuine));
    }

    #[test]
    fn worktree_list_falls_back_on_a_usage_synopsis_rejection() {
        // Some git builds answer an unparsed flag with only the usage synopsis.
        let git = OldGit::new(
            "usage: git worktree list [-v | --porcelain]",
            "worktree /repo/main\nbranch refs/heads/main\n\n",
        );
        assert_eq!(
            get_worktree_list(&git).unwrap(),
            vec![Worktree {
                path: "/repo/main".into(),
                branch: Some("main".into()),
            }]
        );
        assert_eq!(git.calls().len(), 2);
    }

    #[test]
    fn find_worktree_by_branch_also_falls_back() {
        // The fallback is shared, so the other call site degrades identically.
        let git = OldGit::new("error: unknown option `z'", PLAIN_LIST);
        assert_eq!(
            find_worktree_by_branch(&git, "feature").unwrap(),
            Some("/repo/feat".to_string())
        );
        assert_eq!(git.calls().len(), 2);
    }

    #[test]
    fn worktree_list_does_not_retry_a_genuine_git_failure() {
        // "Not a repository" must surface as itself, not be retried and then
        // reported under the fallback command, hiding the real cause.
        let git = FailingGit {
            message: "failed: fatal: not a git repository".to_string(),
            calls: std::cell::RefCell::new(0),
        };
        let err = get_worktree_list(&git).unwrap_err();
        assert!(
            err.to_string().contains("not a git repository"),
            "the original failure must be preserved, got: {err}"
        );
        assert_eq!(*git.calls.borrow(), 1, "a real failure must not be retried");
    }

    #[test]
    fn fallback_output_and_z_output_parse_to_the_same_entries() {
        // One parser serves both invocations, so the two forms must agree.
        let z = "worktree /repo/main\0HEAD aaaa\0branch refs/heads/main\0\0worktree /repo/feat\0HEAD bbbb\0branch refs/heads/feature\0\0";
        assert_eq!(parse_worktree_list(z), parse_worktree_list(PLAIN_LIST));
    }

    #[test]
    fn sanitize_replaces_slashes() {
        assert_eq!(sanitize_branch_name("feat/new-feature"), "feat-new-feature");
        assert_eq!(
            sanitize_branch_name("feat/user/auth/login"),
            "feat-user-auth-login"
        );
        assert_eq!(sanitize_branch_name("simple-branch"), "simple-branch");
        assert_eq!(sanitize_branch_name(""), "");
    }

    #[test]
    fn normalize_https_with_git_suffix() {
        assert_eq!(
            normalize_remote_url("https://github.com/user/repo.git"),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_ssh_scp_format() {
        assert_eq!(
            normalize_remote_url("git@github.com:user/repo.git"),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_ssh_with_protocol() {
        assert_eq!(
            normalize_remote_url("ssh://git@github.com/user/repo.git"),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_http_without_git_suffix() {
        assert_eq!(
            normalize_remote_url("http://github.com/user/repo"),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_url_with_token_credentials() {
        assert_eq!(
            normalize_remote_url("https://token@github.com/user/repo.git"),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_url_with_user_pass_credentials() {
        assert_eq!(
            normalize_remote_url("https://user:pass@github.com/user/repo.git"),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_already_normalized() {
        assert_eq!(
            normalize_remote_url("github.com/user/repo"),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_complex_ssh_with_port() {
        assert_eq!(
            normalize_remote_url("ssh://git@github.com:22/user/repo.git"),
            "github.com:22/user/repo"
        );
    }

    #[test]
    fn normalize_url_with_spaces() {
        assert_eq!(
            normalize_remote_url("  https://github.com/user/repo.git  "),
            "github.com/user/repo"
        );
    }

    #[test]
    fn normalize_gitlab_ssh_nested_groups() {
        assert_eq!(
            normalize_remote_url("git@gitlab.com:group/subgroup/repo.git"),
            "gitlab.com/group/subgroup/repo"
        );
    }

    #[test]
    fn lexical_normalize_folds_dot_and_parent() {
        assert_eq!(lexical_normalize_path("/a/b/../c"), "/a/c");
        assert_eq!(lexical_normalize_path("/a/./b"), "/a/b");
        assert_eq!(lexical_normalize_path("/a//b"), "/a/b");
        assert_eq!(lexical_normalize_path("/a/b/"), "/a/b");
        assert_eq!(lexical_normalize_path("/wt/feat"), "/wt/feat");
        // Relative path with a non-foldable leading `..` keeps it.
        assert_eq!(lexical_normalize_path("../x"), "../x");
    }

    #[test]
    fn get_worktree_by_path_matches_after_normalization() {
        let git = MockGit {
            worktree_list:
                "worktree /test/repo\nbranch refs/heads/main\n\nworktree /test/wt/feat\nbranch refs/heads/feature\n\n"
                    .to_string(),
        };
        // A non-normalized query (with `.` and `..`) still matches the worktree.
        let wt = get_worktree_by_path(&git, "/test/repo/../wt/./feat")
            .unwrap()
            .unwrap();
        assert_eq!(wt.branch.as_deref(), Some("feature"));
        assert_eq!(wt.path, "/test/wt/feat");
    }

    #[test]
    fn get_worktree_by_path_returns_none_when_no_match() {
        let git = MockGit {
            worktree_list: "worktree /test/repo\nbranch refs/heads/main\n\n".to_string(),
        };
        assert_eq!(get_worktree_by_path(&git, "/nowhere").unwrap(), None);
    }

    #[test]
    fn find_worktree_returns_none_when_absent() {
        let git = MockGit {
            worktree_list: "worktree /test/repo\nHEAD abc123\nbranch refs/heads/main\n\n"
                .to_string(),
        };
        assert_eq!(find_worktree_by_branch(&git, "non-existent").unwrap(), None);
    }

    #[test]
    fn find_worktree_returns_path_when_present() {
        let git = MockGit {
            worktree_list: "worktree /test/repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /test/worktrees/feature\nHEAD def456\nbranch refs/heads/feature-branch\n\n"
                .to_string(),
        };
        assert_eq!(
            find_worktree_by_branch(&git, "feature-branch").unwrap(),
            Some("/test/worktrees/feature".to_string())
        );
    }

    // --- Porcelain parser characterization ----------------------------------
    //
    // These lock the CURRENT parse behavior of `parse_worktree_list` against
    // irregular `git worktree list --porcelain` input, so Phase 4 (which adds
    // start/clean over real git) cannot silently change how worktrees are read.

    #[test]
    fn parse_keeps_detached_head_entry_with_no_branch() {
        // A detached-HEAD worktree emits `detached` instead of a `branch` line.
        // It is still a real worktree the user can stand in, so it is reported
        // with `branch: None` rather than dropped.
        let out = "\
worktree /repo/main
HEAD aaaa
branch refs/heads/main

worktree /repo/detached
HEAD bbbb
detached

";
        assert_eq!(
            parse_worktree_list(out),
            vec![
                Worktree {
                    path: "/repo/main".into(),
                    branch: Some("main".into()),
                },
                Worktree {
                    path: "/repo/detached".into(),
                    branch: None,
                },
            ],
            "detached entry must be reported with no branch"
        );
    }

    #[test]
    fn parse_keeps_a_trailing_detached_entry_at_eof() {
        // No trailing blank line: the last entry is flushed at EOF, not lost.
        let out = "worktree /repo/detached\nHEAD bbbb\ndetached";
        assert_eq!(
            parse_worktree_list(out),
            vec![Worktree {
                path: "/repo/detached".into(),
                branch: None,
            }]
        );
    }

    #[test]
    fn parse_handles_worktree_path_with_spaces() {
        // The path is everything after `worktree `, so embedded spaces survive.
        let out = "\
worktree /repo/my worktree dir
HEAD cccc
branch refs/heads/feat

";
        assert_eq!(
            parse_worktree_list(out),
            vec![Worktree {
                path: "/repo/my worktree dir".into(),
                branch: Some("feat".into()),
            }]
        );
    }

    #[test]
    fn parse_handles_nul_delimited_z_output() {
        // What `git worktree list --porcelain -z` actually emits: every record is
        // NUL-TERMINATED (not separated), so an entry ends with `\0\0`. Parsing
        // must produce exactly what the line-oriented form produces.
        let out = "worktree /repo/main\0HEAD aaaa\0branch refs/heads/main\0\0\
                   worktree /repo/detached\0HEAD bbbb\0detached\0\0";
        assert_eq!(
            parse_worktree_list(out),
            vec![
                Worktree {
                    path: "/repo/main".into(),
                    branch: Some("main".into()),
                },
                Worktree {
                    path: "/repo/detached".into(),
                    branch: None,
                },
            ]
        );
    }

    #[test]
    fn parse_keeps_a_newline_inside_a_worktree_path_under_z() {
        // A worktree path may legally contain a literal newline. Under `-z` that
        // byte is interior to the record, so the path must survive INTACT and the
        // entry must not be split into two bogus worktrees.
        let out = "worktree /repo/we\nird\0HEAD aaaa\0branch refs/heads/feat\0\0";
        assert_eq!(
            parse_worktree_list(out),
            vec![Worktree {
                path: "/repo/we\nird".into(),
                branch: Some("feat".into()),
            }],
            "a newline in the path must not act as a record separator"
        );
    }

    #[test]
    fn parse_skips_bare_repository_entry() {
        // A bare main repo emits a `bare` line and no branch; it is skipped, but a
        // following normal worktree still parses (and inherits no stale path).
        let out = "\
worktree /repo/bare.git
bare

worktree /repo/wt
HEAD dddd
branch refs/heads/main

";
        assert_eq!(
            parse_worktree_list(out),
            vec![Worktree {
                path: "/repo/wt".into(),
                branch: Some("main".into()),
            }]
        );
    }

    #[test]
    fn parse_empty_and_whitespace_only_input_yields_no_worktrees() {
        assert!(parse_worktree_list("").is_empty());
        assert!(parse_worktree_list("\n\n").is_empty());
    }

    #[test]
    fn parse_worktree_list_preserves_order() {
        let out = "worktree /a\nbranch refs/heads/main\n\nworktree /b\nbranch refs/heads/feat\n";
        assert_eq!(
            parse_worktree_list(out),
            vec![
                Worktree {
                    path: "/a".into(),
                    branch: Some("main".into())
                },
                Worktree {
                    path: "/b".into(),
                    branch: Some("feat".into())
                },
            ]
        );
    }

    // --- default-branch resolution ------------------------------------------

    /// A runner that answers only the calls listed in `answers` (exact arg-vector
    /// match) and fails everything else, so each test states precisely which
    /// resolution step git is able to satisfy.
    struct ScriptedGit {
        answers: Vec<(Vec<&'static str>, String)>,
    }
    impl ScriptedGit {
        fn new(answers: &[(&[&'static str], &str)]) -> Self {
            ScriptedGit {
                answers: answers
                    .iter()
                    .map(|(args, out)| (args.to_vec(), out.to_string()))
                    .collect(),
            }
        }
    }
    impl GitRunner for ScriptedGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            for (expected, out) in &self.answers {
                if expected.as_slice() == args {
                    return Ok(out.clone());
                }
            }
            Err(VibeError::GitOperation {
                command: args.join(" "),
                message: "failed: not scripted".into(),
            })
        }
    }

    const SYMREF: &[&str] = &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"];
    const INIT_DEFAULT: &[&str] = &["config", "--get", "init.defaultBranch"];

    #[test]
    fn default_branch_comes_from_origin_head_without_the_remote_prefix() {
        let git = ScriptedGit::new(&[(SYMREF, "origin/develop\n")]);
        assert_eq!(get_default_branch(&git), "develop");
    }

    #[test]
    fn default_branch_keeps_slashes_inside_the_branch_name() {
        // Only the leading `origin/` is stripped; `release/` is part of the name.
        let git = ScriptedGit::new(&[(SYMREF, "origin/release/stable")]);
        assert_eq!(get_default_branch(&git), "release/stable");
    }

    #[test]
    fn default_branch_falls_back_to_init_default_branch_config() {
        let git = ScriptedGit::new(&[(INIT_DEFAULT, "trunk\n")]);
        assert_eq!(get_default_branch(&git), "trunk");
    }

    #[test]
    fn default_branch_falls_back_to_master_when_git_knows_nothing() {
        let git = ScriptedGit::new(&[]);
        assert_eq!(get_default_branch(&git), "master");
    }

    #[test]
    fn default_branch_ignores_empty_answers_and_keeps_resolving() {
        // A bare `origin/` and a blank config value must not become the answer.
        let git = ScriptedGit::new(&[(SYMREF, "origin/"), (INIT_DEFAULT, "   ")]);
        assert_eq!(get_default_branch(&git), "master");
    }

    #[test]
    fn detect_broken_link_false_for_git_directory() {
        // A real temp dir with a `.git` *directory* is a main worktree.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        let result = detect_broken_worktree_link(tmp.path());
        assert!(!result.is_broken);
    }

    #[test]
    fn detect_broken_link_false_when_gitdir_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main-repo");
        let gitdir = main.join(".git/worktrees/feature");
        std::fs::create_dir_all(&gitdir).unwrap();
        let wt = tmp.path().join("worktrees/feature");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();

        let result = detect_broken_worktree_link(&wt);
        assert!(!result.is_broken);
    }

    #[test]
    fn detect_broken_link_true_when_gitdir_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main-repo");
        // Note: gitdir path is NOT created on disk.
        let gitdir = main.join(".git/worktrees/feature");
        let wt = tmp.path().join("worktrees/feature");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();

        let result = detect_broken_worktree_link(&wt);
        assert!(result.is_broken);
        assert_eq!(result.git_dir.as_deref(), Some(gitdir.to_str().unwrap()));
        assert_eq!(
            result.main_worktree_path.as_deref(),
            Some(main.to_str().unwrap())
        );
    }
}
