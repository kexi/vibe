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
///
/// `head` is the commit sha the porcelain already carries on its `HEAD <sha>`
/// record. It is kept rather than re-resolved per worktree with `rev-parse`
/// because the enumeration that produced this entry already paid for it, and a
/// second resolution could disagree with the listing if a concurrent checkout
/// lands between the two calls. It is the empty string when the payload carried
/// no `HEAD` record (hand-written fixtures, and a `bare` entry before it is
/// dropped), and the NULL OID when the worktree's branch has no commits yet —
/// see [`is_resolved_oid`], which callers publishing the value must consult.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
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

    /// Run git and return stdout VERBATIM: untrimmed, and as raw BYTES.
    ///
    /// Untrimmed because `-z` (NUL-delimited) plumbing output may contain a path
    /// whose name legitimately begins or ends with whitespace. Bytes rather than
    /// `String` because a lossy decode of the whole stream cannot be undone per
    /// record: a filename with invalid UTF-8 and a filename that genuinely
    /// contains U+FFFD both come back as U+FFFD, so the copy layer could not tell
    /// "undecodable, must warn and skip" from "decodable, copy it". Splitting on
    /// NUL first and decoding each record separately keeps that distinction (see
    /// [`split_nul`]).
    ///
    /// The decoded records are still `String`, not `OsString`: every path seam in
    /// this crate (config, glob, `CopyExecutor`, the `Io` trait) is `String`/`&str`,
    /// so a genuinely non-UTF-8 filename is out of scope and is warned about
    /// rather than silently dropped.
    ///
    /// Defaults to [`GitRunner::run`] so the many test doubles in this crate keep
    /// compiling; [`RealGit`] overrides it with the untrimmed byte capture.
    fn run_raw(&self, args: &[&str]) -> Result<Vec<u8>> {
        self.run(args).map(String::into_bytes)
    }
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

    fn run_raw(&self, args: &[&str]) -> Result<Vec<u8>> {
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
            return Err(VibeError::GitOperation {
                command: args.join(" "),
                message: format!("failed: {}", stderr.trim()),
            });
        }

        Ok(output.stdout)
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
                head: String::new(),
            });
        } else if let Some(rest) = line.strip_prefix("branch refs/heads/") {
            if let Some(wt) = current.as_mut() {
                wt.branch = Some(rest.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            if let Some(wt) = current.as_mut() {
                wt.head = rest.to_string();
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

/// Raw `git -C <path> status --porcelain=v1 -z` payload for one worktree.
///
/// Separate from [`has_uncommitted_changes`], which answers a yes/no question
/// about the *current* directory: this one names the worktree explicitly (`list`
/// reports on trees the process is not standing in) and needs the record payload
/// rather than a boolean so [`count_status_entries_z`] can report a count.
///
/// `--porcelain=v1` is pinned rather than the bare `--porcelain`: the bare form
/// means "the default version", which git documents as subject to change, and a
/// silent switch to v2 would change the record shape under the parser.
///
/// `-z` for the same reason the worktree listing uses it — a changed file's path
/// may contain a newline, and without `-z` git also quotes non-ASCII paths per
/// `core.quotePath`, which would corrupt the record boundaries.
///
/// Why not `-uall`: git's default (`-unormal`) collapses a WHOLLY untracked
/// directory into a single record, so a new directory holding five files counts
/// as one entry. `-uall` would expand it, but it makes git walk every untracked
/// tree in full on EVERY row of the listing — unbounded work in exactly the
/// repositories (a stale `node_modules`, a fat build output) where it is least
/// wanted, to refine a number that only has to convey "there is something
/// here". The count is documented as counting an untracked directory once.
///
/// `--untracked-files=normal` is passed EXPLICITLY rather than relied on as the
/// default: `status.showUntrackedFiles=no` is a real configuration people set to
/// speed up `git status` in big repositories, and under it git reports a
/// worktree holding nothing but new files as completely clean. `list` would then
/// state "clean" about a tree with uncommitted work in it — the one answer this
/// column exists to get right. Passing the flag pins the behaviour to what the
/// docs describe, independent of the user's config.
pub fn worktree_status_z(runner: &impl GitRunner, path: &str) -> Result<Vec<u8>> {
    runner.run_raw(&[
        "-C",
        path,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
    ])
}

/// Number of changed entries in a `git status --porcelain=v1 -z` payload.
///
/// The `-z` form is NOT one record per change: a rename or copy (`R`/`C` in
/// either status column) emits the new path and the original path as TWO
/// NUL-terminated records, with no in-band marker on the second one. Counting
/// records would therefore double-count every rename, so the second record is
/// consumed here as part of its entry.
///
/// Why not `-z` with `--porcelain=v2`: v2 puts both paths of a rename in one
/// record, but it also restructures every other line type, and nothing else in
/// this crate reads v2 — pinning v1 keeps a single porcelain dialect in the
/// codebase.
///
/// Whether an object id names an actual object, rather than "nothing yet".
///
/// git spells the absence of a commit as the NULL OID — all zeros — not as an
/// empty field: `git worktree list --porcelain` reports
/// `HEAD 0000000000000000000000000000000000000000` for a worktree whose branch
/// has no commits (an unborn HEAD). That value looks exactly like a real sha to
/// anything that only checks for emptiness, so a consumer handed it would run
/// `git show <head>` and get `fatal: bad object`.
///
/// Tested by "every byte is `0`" rather than against a 40-character literal:
/// the OID width is the repository's hash algorithm, so a SHA-256 repository
/// (`git init --object-format=sha256`) emits 64 zeros instead. Matching on
/// length would silently stop working there.
///
/// An empty string is not a resolved OID either, so callers get one predicate
/// for both "no `HEAD` record" and "unborn HEAD".
pub fn is_resolved_oid(oid: &str) -> bool {
    !oid.is_empty() && !oid.bytes().all(|b| b == b'0')
}

/// Undecodable bytes are counted, not dropped: a file whose name is not valid
/// UTF-8 is still a change, and the count is only ever displayed as a number.
pub fn count_status_entries_z(payload: &[u8]) -> usize {
    // `-z` terminates (not separates) every record, so the trailing empty slice
    // after the final NUL is dropped rather than counted as an entry.
    let mut records = payload.split(|b| *b == 0).filter(|r| !r.is_empty());
    let mut count = 0;
    while let Some(record) = records.next() {
        count += 1;
        if is_rename_or_copy_record(record) {
            // The original path follows as its own record; it belongs to the
            // entry just counted.
            records.next();
        }
    }
    count
}

/// Whether a porcelain-v1 status record announces a rename or copy, and so is
/// followed by a second record holding the original path.
///
/// The first two bytes are the index/worktree status columns; `R`/`C` in either
/// one means git emitted the `XY <new>\0<orig>\0` pair.
fn is_rename_or_copy_record(record: &[u8]) -> bool {
    record.iter().take(2).any(|b| *b == b'R' || *b == b'C')
}

/// Per-branch facts read in one `git for-each-ref`: commit time and upstream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchRefInfo {
    /// Epoch seconds of the branch tip's committer date.
    pub committed_at_unix: i64,
    /// The tip's committer date in ISO 8601 (`iso8601-strict`).
    pub committed_at_iso: String,
    /// The configured upstream in short form (e.g. `origin/develop`), or `None`
    /// when the branch tracks nothing.
    pub upstream: Option<String>,
}

/// NUL used as the field separator inside a `for-each-ref` record.
///
/// `%00` rather than a printable delimiter because every field except the
/// timestamps is attacker-influenced: a branch named `a|b` or an upstream
/// containing a tab would split into bogus fields under any delimiter that can
/// appear in a ref name, and NUL is the one byte git forbids in one.
const REF_FIELD_SEPARATOR: char = '\0';

/// Read commit time and upstream for the given branches in ONE git call.
///
/// Branches are passed as fully-qualified `refs/heads/<name>` patterns. That is
/// what makes the call injection-proof: a branch named `--format=…` would be a
/// flag if passed bare, but `refs/heads/--format=…` is unambiguously a pattern
/// operand, so no `--` separator or name validation is needed.
///
/// A branch with no commits (an unborn HEAD, e.g. right after `git worktree add
/// -b` on an empty repository) has no ref to enumerate and is simply absent from
/// the result. Callers must treat a missing key as "unknown", not as an error.
///
/// Returns entries keyed by short branch name, in git's emitted order.
pub fn branch_ref_info(
    runner: &impl GitRunner,
    branches: &[String],
) -> Result<Vec<(String, BranchRefInfo)>> {
    if branches.is_empty() {
        return Ok(Vec::new());
    }
    let patterns: Vec<String> = branches
        .iter()
        .map(|b| format!("{BRANCH_REF_PREFIX}{b}"))
        .collect();
    let mut args: Vec<&str> = vec![
        "for-each-ref",
        "--format=%(refname)%00%(committerdate:unix)%00%(committerdate:iso8601-strict)%00%(upstream)%00%(upstream:remotename)",
    ];
    args.extend(patterns.iter().map(String::as_str));
    let output = runner.run(&args)?;
    Ok(parse_ref_info(&output))
}

/// The namespace every local branch ref lives under.
const BRANCH_REF_PREFIX: &str = "refs/heads/";

/// The namespace remote-tracking refs live under.
const REMOTE_REF_PREFIX: &str = "refs/remotes/";

/// Reduce an upstream's FULL refname to a plain branch name.
///
/// `remote_name` is git's own `%(upstream:remotename)` for the same branch: `.`
/// when the upstream is a local branch, otherwise the configured remote.
///
/// Why the full refname and the remote name rather than `%(upstream:short)`:
/// the short form is genuinely ambiguous and cannot be undone by inspection.
/// - A LOCAL upstream (`branch.<b>.remote=.`) shortens to `release/2.0`, which
///   is indistinguishable from remote `release` + branch `2.0`. Treating the
///   first segment as a remote turns the BASE into `2.0` — a wrong branch name
///   presented as fact.
/// - A remote name may itself CONTAIN a slash (`git remote add foo/bar` is
///   accepted), so even for a genuine remote-tracking upstream the first
///   segment is not reliably the remote.
///
/// Taking the remote name from git removes the guess in both cases. A local
/// upstream keeps its name whole; a remote-tracking one has exactly its own
/// remote stripped.
///
/// Returns `None` for an empty upstream (the branch tracks nothing) or a
/// refname outside both namespaces, so the caller degrades to "unknown" rather
/// than displaying a ref it could not interpret.
fn upstream_branch_name(upstream: &str, remote_name: &str) -> Option<String> {
    if upstream.is_empty() {
        return None;
    }
    // A local upstream is an ordinary branch ref; nothing to strip.
    if let Some(branch) = upstream.strip_prefix(BRANCH_REF_PREFIX) {
        return Some(branch.to_string());
    }
    // A remote-tracking ref is `refs/remotes/<remote>/<branch>`, and only git
    // knows where `<remote>` ends.
    let tracking = upstream.strip_prefix(REMOTE_REF_PREFIX)?;
    let branch = tracking
        .strip_prefix(remote_name)
        .and_then(|rest| rest.strip_prefix('/'))?;
    if branch.is_empty() {
        return None;
    }
    Some(branch.to_string())
}

/// Parse the [`branch_ref_info`] format into `(short name, info)` pairs.
///
/// Records are newline-separated (git's `for-each-ref` terminator) and fields
/// are NUL-separated. A record whose timestamp does not parse, or which has too
/// few fields, is skipped: it can only mean git emitted something this parser
/// does not model, and dropping the row degrades to "age unknown" rather than
/// failing the whole listing.
///
/// The key comes from `%(refname)` with [`BRANCH_REF_PREFIX`] stripped here,
/// NOT from `%(refname:short)`. git's own shortening is ambiguity-aware: when a
/// tag shares a branch's name it shortens `refs/heads/release` to `heads/release`
/// rather than `release`, which would no longer match the branch name the caller
/// looked up — the row would silently lose its AGE and upstream. Stripping a
/// fixed prefix off the full refname is exact because the caller only ever asks
/// for `refs/heads/` patterns.
///
/// The upstream is resolved the same way, by [`upstream_branch_name`], from the
/// full refname plus git's own remote name rather than from `%(upstream:short)`.
pub fn parse_ref_info(output: &str) -> Vec<(String, BranchRefInfo)> {
    output
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let mut fields = line.split(REF_FIELD_SEPARATOR);
            let name = fields.next()?.strip_prefix(BRANCH_REF_PREFIX)?;
            let unix = fields.next()?.parse::<i64>().ok()?;
            let iso = fields.next()?;
            // Both fields come straight from git; an unset upstream renders
            // them empty, which `upstream_branch_name` reads as "tracks nothing".
            let upstream_ref = fields.next().unwrap_or_default();
            let remote_name = fields.next().unwrap_or_default();
            Some((
                name.to_string(),
                BranchRefInfo {
                    committed_at_unix: unix,
                    committed_at_iso: iso.to_string(),
                    upstream: upstream_branch_name(upstream_ref, remote_name),
                },
            ))
        })
        .collect()
}

/// Commit time of a detached worktree's HEAD (`git -C <path> log -1`).
///
/// A detached HEAD has no branch, so [`branch_ref_info`] cannot see it; this is
/// the per-worktree fallback. It is `log -1` on the worktree rather than
/// `for-each-ref` on the sha because `for-each-ref` enumerates refs, and a
/// detached HEAD is by definition not one.
///
/// Returns `None` on any failure (broken worktree, unborn HEAD), so a single
/// unreadable worktree degrades to "age unknown" instead of failing the listing.
pub fn detached_head_info(runner: &impl GitRunner, path: &str) -> Option<(i64, String)> {
    let out = runner
        .run(&["-C", path, "log", "-1", "--format=%ct%x00%cI"])
        .ok()?;
    let mut fields = out.trim().split(REF_FIELD_SEPARATOR);
    let unix = fields.next()?.parse::<i64>().ok()?;
    let iso = fields.next()?;
    Some((unix, iso.to_string()))
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

/// One record of NUL-delimited `git ... -z` output, after per-record decoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitPathRecord {
    /// The record was valid UTF-8 and is usable as a path.
    Valid(String),
    /// The record was NOT valid UTF-8. Carries the lossy rendering, which is only
    /// good enough to name the file in a warning — it does not refer to anything
    /// on disk and must never be used as a copy source.
    Undecodable(String),
}

/// Split NUL-delimited `git ... -z` output into non-empty entries, decoding each
/// record independently.
///
/// `-z` terminates every record with a NUL (including the last), so the split
/// yields a trailing empty element that is dropped here. Entries are NOT trimmed:
/// a path may legitimately start or end with whitespace.
///
/// The decode is per record rather than over the whole stream so that only bytes
/// that are actually invalid UTF-8 yield [`GitPathRecord::Undecodable`]. A
/// filename that genuinely contains U+FFFD decodes cleanly and stays
/// [`GitPathRecord::Valid`] — a whole-stream `from_utf8_lossy` would make the two
/// cases indistinguishable and wrongly exclude the legitimate file.
pub fn split_nul(output: &[u8]) -> Vec<GitPathRecord> {
    output
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|record| match std::str::from_utf8(record) {
            Ok(s) => GitPathRecord::Valid(s.to_string()),
            Err(_) => GitPathRecord::Undecodable(String::from_utf8_lossy(record).into_owned()),
        })
        .collect()
}

/// Pathspec that widens `git ls-files` from "under the current directory" to
/// "the whole repository".
///
/// `--full-name` only fixes the path FORMAT (repo-root-relative instead of
/// cwd-relative); it does not widen the SCOPE. Without a pathspec, a run from a
/// subdirectory lists only that subtree, so `vibe start` invoked from e.g.
/// `packages/docs/` would silently carry over just that subtree's files. `:/`
/// is the magic "from the repository root" pathspec, and the preceding `--`
/// stops git from mistaking it for an option.
const REPO_WIDE_PATHSPEC: [&str; 2] = ["--", ":/"];

/// Repo-relative paths of untracked, non-ignored files
/// (`git ls-files -z --others --exclude-standard`).
///
/// `-z` is mandatory: without it git would quote paths per `core.quotePath` and
/// break on embedded newlines. `--full-name` makes the emitted paths relative to
/// the repository root, and [`REPO_WIDE_PATHSPEC`] makes the listing cover the
/// whole repository regardless of the process's current directory.
pub fn list_untracked_files(runner: &impl GitRunner) -> Result<Vec<GitPathRecord>> {
    let mut args = vec![
        "ls-files",
        "-z",
        "--others",
        "--exclude-standard",
        "--full-name",
    ];
    args.extend_from_slice(&REPO_WIDE_PATHSPEC);
    let out = runner.run_raw(&args)?;
    Ok(split_nul(&out))
}

/// Repo-relative paths of tracked files with local modifications
/// (`git ls-files -z --modified`).
///
/// `--modified` also reports DELETED tracked files; the caller filters those out
/// by existence (a deleted file has nothing to copy).
pub fn list_modified_files(runner: &impl GitRunner) -> Result<Vec<GitPathRecord>> {
    let mut args = vec!["ls-files", "-z", "--modified", "--full-name"];
    args.extend_from_slice(&REPO_WIDE_PATHSPEC);
    let out = runner.run_raw(&args)?;
    Ok(split_nul(&out))
}

/// The remote HEAD symref every default-branch lookup starts from.
///
/// Named once because it is used three ways — as a `symbolic-ref` operand, as a
/// `for-each-ref` pattern, and as the exact refname that pattern's output is
/// compared against — and a typo in the third would silently turn every
/// confirmation into "unconfirmed".
const ORIGIN_HEAD_REF: &str = "refs/remotes/origin/HEAD";

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
///    have created (covers repos with no remote). Read with `--default ""` so an
///    unset key is a successful empty answer rather than a non-zero exit.
/// 3. [`FALLBACK_DEFAULT_BRANCH`].
///
/// Never fails: every git call is best-effort, because this feeds a *guard*, and
/// a guard that errors out would break `clean`/`rename` in repositories where
/// git simply has no opinion.
pub fn get_default_branch(runner: &impl GitRunner) -> String {
    resolve_default_branch(runner).name
}

/// A default-branch answer, plus whether it is REPEATABLE.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultBranch {
    pub name: String,
    /// `true` when the answer will be the same on the next run; `false` when a
    /// git command FAILED, so the same repository could answer differently a
    /// moment later.
    ///
    /// Note what this is NOT: "git gave us a name". A repository with no remote
    /// and no `init.defaultBranch` is answered from
    /// [`FALLBACK_DEFAULT_BRANCH`], and that is still `resolved: true` — the
    /// absence is a stable property of the repository, so the fallback is
    /// deterministic and every run produces it. Treating it as unresolved would
    /// permanently disable anything keyed on the answer for the very common
    /// case of a purely local repository.
    ///
    /// What makes an answer unrepeatable is an ERROR: a probe that failed for a
    /// reason unrelated to the value being absent (a locked index, a permission
    /// problem, a corrupt ref store). Then the hardcoded name is standing in for
    /// something git would normally have told us, and the next run may well
    /// disagree.
    pub resolved: bool,
}

/// [`get_default_branch`] with the resolution outcome attached.
///
/// Split out rather than changing the existing signature: `clean` and `rename`
/// use this as a guard, where a guessed name is exactly as usable as a
/// resolved one — only the summary cache needs to tell them apart.
///
/// # The value and the confidence are computed separately
///
/// The resolution ORDER is [`get_default_branch`]'s, unchanged and unconditional:
/// `symbolic-ref` → `init.defaultBranch` → [`FALLBACK_DEFAULT_BRANCH`], each
/// step tried whatever the previous one did. That matters because this name
/// arms the default-branch guards in `clean` and `rename`: a step that gets
/// skipped can turn a protected `main` into an unrecognized one and let
/// `vibe rename` proceed on the branch it was supposed to refuse. No probe may
/// stand between those steps.
///
/// `resolved` is therefore computed ALONGSIDE the value, never in front of it.
/// It answers a narrower question — "would the next run get this same answer?" —
/// which only the summary cache asks, and only to decide whether a key derived
/// from the name is worth storing.
///
/// # Confirming an absence
///
/// `resolved` must distinguish "git says there is no value" from "git could not
/// tell us", and the [`GitRunner`] seam makes that impossible to read off an
/// exit code: every non-zero exit becomes an `Err`, so a missing ref and a
/// locked ref store look identical. A command that signals absence by exiting
/// non-zero (`show-ref --verify`, a bare `config --get`) therefore cannot answer
/// it — one transient fault hitting both that command AND the reader makes a
/// guessed `master` look confirmed.
///
/// The two confirmations used here exit ZERO in a working repository whether or
/// not the value is set, and report absence as EMPTY OUTPUT:
///
/// - `for-each-ref refs/remotes/origin/HEAD` — consulted ONLY when
///   `symbolic-ref` already failed, to tell "there is no such ref" from "there
///   is one and it could not be read".
/// - `config --default "" --get init.defaultBranch` — empty when unset
///   (`--default` is git 2.18+, well below anything this project builds with).
///
/// Why `for-each-ref` cannot be trusted on its own: it enumerates refs that
/// RESOLVE, so a `refs/remotes/origin/HEAD` whose target is momentarily missing
/// (mid-fetch, mid-prune) is omitted and looks absent. `symbolic-ref` reads the
/// symref's own contents regardless of its target, so asking it first both
/// resolves that case correctly and keeps the enumeration's blind spot off the
/// value path entirely.
///
/// # The one rule for everything below step 1
///
/// Every answer that is NOT `symbolic-ref`'s — the configured name and the
/// hardcoded fallback alike — is only reached because step 1 produced nothing,
/// so each is repeatable exactly when that nothing was CONFIRMED: the probe
/// answered, and answered empty. If step 1 merely failed, the next run may read
/// `origin/HEAD` perfectly well and return something else, which makes anything
/// keyed on today's answer stale without a single visible change.
pub fn resolve_default_branch(runner: &impl GitRunner) -> DefaultBranch {
    let resolved = |name: String| DefaultBranch {
        name,
        resolved: true,
    };

    // Step 1: the authoritative source. Reads the symref's contents even when
    // its target is missing, so a dangling origin/HEAD resolves correctly here
    // and never reaches the enumeration below.
    if let Ok(out) = runner.run(&["symbolic-ref", ORIGIN_HEAD_REF, "--short"]) {
        if let Some(name) = strip_remote_prefix(out.trim()) {
            return resolved(name);
        }
    }

    // Step 1 gave us nothing. Only NOW does it matter why: an absent ref makes
    // the remaining fallbacks this repository's permanent answer, while a ref we
    // could not read makes them a stand-in for something git would have told us.
    //
    // The pattern matches by PREFIX, so a ref named `refs/remotes/origin/HEAD/foo`
    // is enumerated even when `refs/remotes/origin/HEAD` itself does not exist
    // (verified against git: creating only the former makes the bare pattern
    // report a hit). `--format=%(refname)` and an exact comparison make the
    // answer mean what it is being asked to mean. Getting this wrong is a
    // performance bug rather than a correctness one — a permanently
    // "unconfirmed" absence re-runs the summary command every listing — but the
    // fix costs nothing.
    let origin_head_absent =
        match runner.run(&["for-each-ref", "--format=%(refname)", ORIGIN_HEAD_REF]) {
            // Enumerated nothing named exactly that: there is no such ref (or its
            // target is missing, which step 1 would already have resolved).
            Ok(out) => !out.lines().any(|line| line.trim() == ORIGIN_HEAD_REF),
            // Cannot even ask, so nothing below can be called confirmed.
            Err(_) => false,
        };

    // Step 2: what a fresh `git init` here would have created. Reached
    // unconditionally — a failed probe must never cost us this answer.
    let configured = runner.run(&["config", "--default", "", "--get", "init.defaultBranch"]);
    if let Ok(out) = &configured {
        let trimmed = out.trim();
        if !trimmed.is_empty() {
            // The VALUE is this config's, whatever the probe said. Its
            // REPEATABILITY, though, depends on origin/HEAD really being absent:
            // this config is only the answer because step 1 produced nothing, so
            // if step 1 merely FAILED, the next run may read origin/HEAD fine
            // and return something else entirely. Re-pointing origin/HEAD at
            // `develop` while `symbolic-ref` is momentarily unavailable would
            // otherwise report the config's `main` as confirmed, and a cache key
            // built on the old BASE would hit.
            return DefaultBranch {
                name: trimmed.to_string(),
                resolved: origin_head_absent,
            };
        }
    }

    // Step 3: the hardcoded fallback. Repeatable only when BOTH earlier sources
    // confirmed — rather than merely failed to produce — an absence.
    let config_absent = configured.is_ok();
    DefaultBranch {
        name: FALLBACK_DEFAULT_BRANCH.to_string(),
        resolved: origin_head_absent && config_absent,
    }
}

/// Strip the leading `origin/` from a `symbolic-ref --short` answer.
///
/// Returns `None` for an empty input or a bare `origin/` with nothing after it,
/// so the caller falls through to the next resolution step instead of adopting
/// an empty branch name (which would make the guard match every branch).
///
/// Scoped to [`get_default_branch`], whose single caller queries the literal
/// `refs/remotes/origin/HEAD`: the remote is fixed at the call site, so the
/// prefix is a known constant and not an inference. Do NOT reuse this for an
/// arbitrary upstream — there the remote name is neither known to be `origin`
/// nor guaranteed to be a single path segment (`git remote add foo/bar` is
/// accepted); [`upstream_branch_name`] handles that case with git's own answer.
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
                head: String::new(),
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
                    head: "aaaa".into(),
                },
                Worktree {
                    path: "/repo/feat".into(),
                    branch: Some("feature".into()),
                    head: "bbbb".into(),
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
                head: String::new(),
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
                    head: "aaaa".into(),
                },
                Worktree {
                    path: "/repo/detached".into(),
                    branch: None,
                    head: "bbbb".into(),
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
                head: "bbbb".into(),
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
                head: "cccc".into(),
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
                    head: "aaaa".into(),
                },
                Worktree {
                    path: "/repo/detached".into(),
                    branch: None,
                    head: "bbbb".into(),
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
                head: "aaaa".into(),
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
                head: "dddd".into(),
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
                    branch: Some("main".into()),
                    head: String::new(),
                },
                Worktree {
                    path: "/b".into(),
                    branch: Some("feat".into()),
                    head: String::new(),
                },
            ]
        );
    }

    /// A runner that answers `ls-files` from a canned NUL-delimited byte payload
    /// via `run_raw`, and would CORRUPT the payload if `run` (which trims and
    /// decodes lossily) were used.
    struct LsFilesGit {
        raw: Vec<u8>,
        args: std::cell::RefCell<Vec<String>>,
    }
    impl LsFilesGit {
        fn new(raw: &str) -> Self {
            Self {
                raw: raw.as_bytes().to_vec(),
                args: std::cell::RefCell::new(Vec::new()),
            }
        }
        fn recorded_args(&self) -> Vec<String> {
            self.args.borrow().clone()
        }
    }
    impl GitRunner for LsFilesGit {
        fn run(&self, _args: &[&str]) -> Result<String> {
            Ok(String::from_utf8_lossy(&self.raw).trim().to_string())
        }
        fn run_raw(&self, args: &[&str]) -> Result<Vec<u8>> {
            *self.args.borrow_mut() = args.iter().map(|a| a.to_string()).collect();
            Ok(self.raw.clone())
        }
    }

    fn valid(items: &[&str]) -> Vec<GitPathRecord> {
        items
            .iter()
            .map(|s| GitPathRecord::Valid(s.to_string()))
            .collect()
    }

    #[test]
    fn split_nul_drops_the_trailing_terminator_only() {
        assert_eq!(split_nul(b"a\0b\0"), valid(&["a", "b"]));
        assert_eq!(split_nul(b""), Vec::<GitPathRecord>::new());
    }

    #[test]
    fn split_nul_preserves_paths_with_newlines_and_spaces() {
        // A NUL-delimited record may itself contain a newline or leading/trailing
        // spaces; neither may be treated as a separator or stripped.
        assert_eq!(
            split_nul("we ird\nname.txt\0 padded \0".as_bytes()),
            valid(&["we ird\nname.txt", " padded "])
        );
    }

    #[test]
    fn split_nul_marks_only_the_undecodable_record() {
        // Per-record decoding: one bad record must not taint its neighbours, and a
        // record that legitimately CONTAINS U+FFFD is valid, not undecodable.
        let mut payload = b"ok.txt\0bad".to_vec();
        payload.push(0xff);
        payload.extend_from_slice(b".txt\0");
        payload.extend_from_slice("real\u{fffd}.txt\0".as_bytes());
        assert_eq!(
            split_nul(&payload),
            vec![
                GitPathRecord::Valid("ok.txt".to_string()),
                GitPathRecord::Undecodable("bad\u{fffd}.txt".to_string()),
                GitPathRecord::Valid("real\u{fffd}.txt".to_string()),
            ]
        );
    }

    #[test]
    fn untracked_listing_keeps_non_ascii_and_spaced_paths() {
        let git = LsFilesGit::new("notes/メモ.txt\0my file.txt\0");
        assert_eq!(
            list_untracked_files(&git).unwrap(),
            valid(&["notes/メモ.txt", "my file.txt"])
        );
    }

    #[test]
    fn modified_listing_reads_raw_untrimmed_output() {
        // Trailing whitespace inside the final record survives because the helper
        // reads `run_raw`, not the trimming `run`.
        let git = LsFilesGit::new("src/main.rs\0trailing \0");
        assert_eq!(
            list_modified_files(&git).unwrap(),
            valid(&["src/main.rs", "trailing "])
        );
    }

    #[test]
    fn ls_files_listings_are_scoped_to_the_whole_repository() {
        // Guarantee: both listings ask git for the entire repository, not just the
        // subtree below the process's current directory. `--full-name` alone only
        // reformats paths, so the trailing `-- :/` pathspec is what makes a run
        // from a subdirectory still see files elsewhere in the repo.
        let untracked = LsFilesGit::new("a.txt\0");
        list_untracked_files(&untracked).unwrap();
        let args = untracked.recorded_args();
        assert_eq!(&args[args.len() - 2..], &["--", ":/"]);
        assert!(args.contains(&"--others".to_string()));

        let modified = LsFilesGit::new("b.txt\0");
        list_modified_files(&modified).unwrap();
        let args = modified.recorded_args();
        assert_eq!(&args[args.len() - 2..], &["--", ":/"]);
        assert!(args.contains(&"--modified".to_string()));
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
    const INIT_DEFAULT: &[&str] = &["config", "--default", "", "--get", "init.defaultBranch"];
    /// The zero-exit probe that confirms whether `refs/remotes/origin/HEAD`
    /// exists: empty output means confirmed-absent.
    const ORIGIN_HEAD_PROBE: &[&str] = &[
        "for-each-ref",
        "--format=%(refname)",
        "refs/remotes/origin/HEAD",
    ];
    /// A probe answer naming the ref exactly, i.e. it is present.
    const ORIGIN_HEAD_PRESENT: &str = "refs/remotes/origin/HEAD\n";

    #[test]
    fn default_branch_comes_from_origin_head_without_the_remote_prefix() {
        let git = ScriptedGit::new(&[
            (ORIGIN_HEAD_PROBE, ORIGIN_HEAD_PRESENT),
            (SYMREF, "origin/develop\n"),
        ]);
        assert_eq!(get_default_branch(&git), "develop");
    }

    #[test]
    fn default_branch_keeps_slashes_inside_the_branch_name() {
        // Only the leading `origin/` is stripped; `release/` is part of the name.
        let git = ScriptedGit::new(&[
            (ORIGIN_HEAD_PROBE, ORIGIN_HEAD_PRESENT),
            (SYMREF, "origin/release/stable"),
        ]);
        assert_eq!(get_default_branch(&git), "release/stable");
    }

    #[test]
    fn default_branch_falls_back_to_init_default_branch_config() {
        // The probe answers empty (no origin/HEAD), so resolution moves on to
        // the config — which is where the answer is.
        let git = ScriptedGit::new(&[(ORIGIN_HEAD_PROBE, ""), (INIT_DEFAULT, "trunk\n")]);
        assert_eq!(get_default_branch(&git), "trunk");
    }

    #[test]
    fn default_branch_falls_back_to_master_when_git_knows_nothing() {
        // Both probes answer, both are empty: a confirmed, stable absence.
        let git = ScriptedGit::new(&[(ORIGIN_HEAD_PROBE, ""), (INIT_DEFAULT, "")]);
        assert_eq!(get_default_branch(&git), "master");
    }

    /// (a) What it guarantees: a probe that ERRORS is degradation, not absence.
    ///
    /// This is the case an exit-code-based probe could not express: one
    /// transient fault hitting both the probe and the reader made a guessed
    /// `master` look confirmed. The probe exits zero in a working repository, so
    /// an `Err` can only mean something went wrong.
    #[test]
    fn a_failing_origin_head_probe_is_degraded_not_absent() {
        // Nothing scripted, so every command errors.
        let git = ScriptedGit::new(&[]);
        let answer = resolve_default_branch(&git);
        assert_eq!(answer.name, "master", "the display fallback is unchanged");
        assert!(
            !answer.resolved,
            "an unaskable probe cannot confirm absence"
        );
    }

    /// What it guarantees: the precise hole the exit-code probe left open — ONE
    /// transient fault taking out both the existence probe and the reader.
    ///
    /// With an `is_ok()`-style probe, the failure was read as "the ref is
    /// absent", the config then legitimately answered empty, and the guessed
    /// `master` was reported as confirmed. Both facts must come from a command
    /// that SUCCEEDED for the answer to be repeatable.
    #[test]
    fn a_fault_hitting_both_the_probe_and_the_reader_is_degraded() {
        // The probe and `symbolic-ref` both fail (unscripted); the config probe
        // answers empty, exactly as it would in a healthy local repository.
        let git = ScriptedGit::new(&[(INIT_DEFAULT, "")]);
        let answer = resolve_default_branch(&git);
        assert_eq!(answer.name, "master", "the display fallback is unchanged");
        assert!(
            !answer.resolved,
            "a failed probe must never be read as a confirmed absence"
        );
    }

    /// What it guarantees: the VALUE `get_default_branch` returns is unaffected
    /// by the confirmation probe, in every combination of probe outcomes.
    ///
    /// This is the invariant the `clean` and `rename` default-branch guards rest
    /// on. When the probe was moved to the front of the chain, a `for-each-ref`
    /// failure alone short-circuited resolution: a repository whose default
    /// branch is `main` via `init.defaultBranch` reported `master`, the guard
    /// stopped recognizing its own default branch, and `vibe rename` would
    /// proceed on a branch it exists to refuse.
    #[test]
    fn the_resolved_name_never_depends_on_the_confirmation_probe() {
        // `init.defaultBranch` is the answer; vary only the probe's outcome.
        for probe in [
            None,                      // probe errors
            Some(""),                  // probe says absent
            Some(ORIGIN_HEAD_PRESENT), // probe says present
        ] {
            let mut script: Vec<(&[&str], &str)> = vec![(INIT_DEFAULT, "main\n")];
            if let Some(answer) = probe {
                script.push((ORIGIN_HEAD_PROBE, answer));
            }
            let git = ScriptedGit::new(&script);
            assert_eq!(
                get_default_branch(&git),
                "main",
                "the probe outcome must not change the VALUE (probe: {probe:?})"
            );
        }
    }

    /// What it guarantees: `symbolic-ref` still wins outright, and is consulted
    /// FIRST — so a dangling `refs/remotes/origin/HEAD` resolves correctly.
    ///
    /// `for-each-ref` enumerates refs that RESOLVE, so an origin/HEAD whose
    /// target is momentarily missing (mid-fetch, mid-prune) is omitted and looks
    /// absent. Asking `symbolic-ref` first — it reads the symref's own contents
    /// regardless of its target — keeps that blind spot off the value path.
    #[test]
    fn a_dangling_origin_head_still_resolves_through_symbolic_ref() {
        // Exactly what git does in this state, measured: the enumeration is
        // empty while `symbolic-ref` still reports the target.
        let git = ScriptedGit::new(&[(SYMREF, "origin/main\n"), (ORIGIN_HEAD_PROBE, "")]);
        let answer = resolve_default_branch(&git);
        assert_eq!(
            answer.name, "main",
            "a dangling symref still names its target"
        );
        assert!(
            answer.resolved,
            "reading the symref succeeded, so the answer is repeatable"
        );
    }

    /// What it guarantees: `init.defaultBranch` is reached even when the
    /// confirmation probe failed — the probe may cost confidence, never a step.
    #[test]
    fn a_failing_probe_does_not_skip_the_config_source() {
        // symbolic-ref and the probe both error; the config still answers.
        let git = ScriptedGit::new(&[(INIT_DEFAULT, "trunk\n")]);
        let answer = resolve_default_branch(&git);
        assert_eq!(
            answer.name, "trunk",
            "the config source must still be tried"
        );
        // But NOT repeatable: the config is only the answer because step 1
        // produced nothing, and a failed probe cannot confirm that nothing was
        // real. See `a_config_name_is_unconfirmed_while_origin_head_may_exist`.
        assert!(
            !answer.resolved,
            "an unconfirmed step-1 absence cannot make step 2 repeatable"
        );
    }

    /// What it guarantees: the probe's pattern is matched EXACTLY, so a ref that
    /// merely starts with `refs/remotes/origin/HEAD` does not make an absent
    /// origin/HEAD look present.
    ///
    /// `for-each-ref` matches by prefix — verified against git: with only
    /// `refs/remotes/origin/HEAD/foo` created, the bare pattern reports a hit.
    /// Reading that as "present" would leave a repository's stable config-based
    /// BASE permanently unconfirmed, re-running the summary command on every
    /// listing. A performance bug rather than a correctness one, but a silent one.
    #[test]
    fn a_ref_merely_prefixed_by_origin_head_does_not_count_as_present() {
        let git = ScriptedGit::new(&[
            // Exactly what git enumerates in that state.
            (ORIGIN_HEAD_PROBE, "refs/remotes/origin/HEAD/foo\n"),
            (INIT_DEFAULT, "main\n"),
        ]);
        let answer = resolve_default_branch(&git);
        assert_eq!(answer.name, "main");
        assert!(
            answer.resolved,
            "origin/HEAD itself is absent, so the config is the stable answer"
        );
    }

    /// The complement: the ref named exactly is still recognized as present.
    #[test]
    fn the_exact_origin_head_ref_counts_as_present() {
        let git = ScriptedGit::new(&[
            (ORIGIN_HEAD_PROBE, ORIGIN_HEAD_PRESENT),
            (INIT_DEFAULT, "main\n"),
        ]);
        let answer = resolve_default_branch(&git);
        assert_eq!(answer.name, "main");
        assert!(
            !answer.resolved,
            "origin/HEAD exists but could not be read, so nothing below is confirmed"
        );
    }

    /// And a mixture: the exact ref alongside a prefixed sibling still counts.
    #[test]
    fn the_exact_ref_is_found_among_prefixed_siblings() {
        let git = ScriptedGit::new(&[(
            ORIGIN_HEAD_PROBE,
            "refs/remotes/origin/HEAD/foo\nrefs/remotes/origin/HEAD\n",
        )]);
        assert!(!resolve_default_branch(&git).resolved);
    }

    /// (a) What it guarantees: a config-sourced name is NOT repeatable while
    /// `origin/HEAD` might still exist.
    ///
    /// The scenario: `origin/HEAD` is re-pointed at `develop`, then
    /// `symbolic-ref` momentarily fails. The probe reports the ref is there, so
    /// the config's `main` is only standing in for a value git would normally
    /// have given — and treating it as confirmed lets a cache key built on the
    /// OLD base hit, silently serving a summary for the wrong upstream.
    #[test]
    fn a_config_name_is_unconfirmed_while_origin_head_may_exist() {
        // symbolic-ref unscripted (=> Err); the probe says the ref is present.
        let git = ScriptedGit::new(&[
            (ORIGIN_HEAD_PROBE, ORIGIN_HEAD_PRESENT),
            (INIT_DEFAULT, "main\n"),
        ]);
        let answer = resolve_default_branch(&git);
        assert_eq!(answer.name, "main", "the VALUE is still the config's");
        assert!(
            !answer.resolved,
            "origin/HEAD exists but could not be read, so nothing below it is confirmed"
        );
    }

    /// (b) What it guarantees: the same holds when the probe itself failed —
    /// an unaskable probe confirms nothing either.
    #[test]
    fn a_config_name_is_unconfirmed_when_the_probe_cannot_answer() {
        // Only the config is scripted: symbolic-ref AND the probe both error.
        let git = ScriptedGit::new(&[(INIT_DEFAULT, "main\n")]);
        let answer = resolve_default_branch(&git);
        assert_eq!(answer.name, "main");
        assert!(!answer.resolved);
    }

    /// (c) What it guarantees: a CONFIRMED absence still makes the config's name
    /// repeatable — the purely local repository keeps its cache.
    #[test]
    fn a_config_name_is_confirmed_when_origin_head_is_confirmed_absent() {
        let git = ScriptedGit::new(&[(ORIGIN_HEAD_PROBE, ""), (INIT_DEFAULT, "main\n")]);
        let answer = resolve_default_branch(&git);
        assert_eq!(answer.name, "main");
        assert!(
            answer.resolved,
            "a confirmed absence makes the config the repository's stable answer"
        );
    }

    /// (b) What it guarantees: both probes answering EMPTY is a confirmed,
    /// repeatable absence — the purely local repository stays cacheable.
    #[test]
    fn a_confirmed_absence_is_resolved() {
        let git = ScriptedGit::new(&[(ORIGIN_HEAD_PROBE, ""), (INIT_DEFAULT, "")]);
        let answer = resolve_default_branch(&git);
        assert_eq!(answer.name, "master");
        assert!(
            answer.resolved,
            "a stable absence is repeatable and must stay cacheable"
        );
    }

    /// (c) What it guarantees: a failing CONFIG probe is degradation too, even
    /// though the first probe succeeded.
    #[test]
    fn a_failing_config_probe_is_degraded() {
        // origin/HEAD confirmed absent, but the config probe cannot be read.
        let git = ScriptedGit::new(&[(ORIGIN_HEAD_PROBE, "")]);
        let answer = resolve_default_branch(&git);
        assert_eq!(answer.name, "master");
        assert!(!answer.resolved);
    }

    /// What it guarantees: an existing `origin/HEAD` that cannot be read through
    /// is degradation — the exact combination the previous probe got wrong.
    #[test]
    fn an_unreadable_existing_origin_head_is_degraded() {
        // The ref exists, but `symbolic-ref` fails (unscripted).
        let git = ScriptedGit::new(&[(ORIGIN_HEAD_PROBE, ORIGIN_HEAD_PRESENT)]);
        let answer = resolve_default_branch(&git);
        assert_eq!(answer.name, "master");
        assert!(!answer.resolved);
    }

    /// What it guarantees: a successfully resolved name is repeatable.
    #[test]
    fn a_resolved_name_is_repeatable() {
        let git = ScriptedGit::new(&[
            (ORIGIN_HEAD_PROBE, ORIGIN_HEAD_PRESENT),
            (SYMREF, "origin/develop\n"),
        ]);
        assert!(resolve_default_branch(&git).resolved);
    }

    #[test]
    fn default_branch_ignores_empty_answers_and_keeps_resolving() {
        // A bare `origin/` and a blank config value must not become the answer.
        let git = ScriptedGit::new(&[
            (ORIGIN_HEAD_PROBE, ORIGIN_HEAD_PRESENT),
            (SYMREF, "origin/"),
            (INIT_DEFAULT, "   "),
        ]);
        assert_eq!(get_default_branch(&git), "master");
    }

    // --- status / ref parsing ----------------------------------------------

    #[test]
    fn status_count_treats_a_rename_as_one_entry() {
        // `-z` emits a rename as TWO records (`R  <new>\0<orig>\0`) with no
        // marker on the second, so counting records would double-count it.
        let payload = b"R  new.txt\0old.txt\0 M other.txt\0";
        assert_eq!(count_status_entries_z(payload), 2);
    }

    #[test]
    fn status_count_treats_a_copy_as_one_entry() {
        let payload = b"C  copy.txt\0src.txt\0";
        assert_eq!(count_status_entries_z(payload), 1);
    }

    #[test]
    fn status_count_sees_a_rename_marked_in_the_worktree_column() {
        // The `R` can be in either status column; only `RM`/`R ` are common but
        // ` R` is emitted for a worktree-side rename.
        let payload = b" R new.txt\0old.txt\0";
        assert_eq!(count_status_entries_z(payload), 1);
    }

    #[test]
    fn status_count_keeps_a_newline_inside_a_path_in_one_record() {
        // The reason `-z` is used at all: without it this path would be quoted
        // or split, and the count would be wrong.
        let payload = b" M we\nird.txt\0?? other.txt\0";
        assert_eq!(count_status_entries_z(payload), 2);
    }

    #[test]
    fn status_count_of_an_empty_payload_is_zero() {
        assert_eq!(count_status_entries_z(b""), 0);
        // A payload of nothing but the trailing terminator is still zero.
        assert_eq!(count_status_entries_z(b"\0"), 0);
    }

    #[test]
    fn status_count_treats_a_wholly_untracked_directory_as_one_entry() {
        // What it guarantees: the count reflects git's DEFAULT (`-unormal`)
        // reporting, where a wholly untracked directory arrives as a single
        // `?? dir/` record no matter how many files are inside it. This is the
        // documented meaning of the number, and the reason `-uall` is not used.
        let payload = b"?? newdir/\0 M tracked.txt\0";
        assert_eq!(count_status_entries_z(payload), 2);
    }

    #[test]
    fn status_count_does_not_mistake_an_r_in_a_filename_for_a_rename() {
        // Only the two STATUS columns are inspected; a path starting with `R`
        // is at offset 3 and must not consume the next record.
        let payload = b" M Readme.md\0?? Rust.toml\0";
        assert_eq!(count_status_entries_z(payload), 2);
    }

    #[test]
    fn ref_info_parses_the_nul_separated_fields() {
        let out = "refs/heads/main\x001700000000\x002023-11-14T22:13:20+00:00\x00refs/remotes/origin/main\x00origin\n\
                   refs/heads/feat/x\x001700000100\x002023-11-14T22:15:00+00:00\x00\x00\n";
        assert_eq!(
            parse_ref_info(out),
            vec![
                (
                    "main".to_string(),
                    BranchRefInfo {
                        committed_at_unix: 1_700_000_000,
                        committed_at_iso: "2023-11-14T22:13:20+00:00".to_string(),
                        // Reduced to a plain branch name by the parser.
                        upstream: Some("main".to_string()),
                    }
                ),
                (
                    "feat/x".to_string(),
                    BranchRefInfo {
                        committed_at_unix: 1_700_000_100,
                        committed_at_iso: "2023-11-14T22:15:00+00:00".to_string(),
                        // An unset upstream renders as an empty field, which is
                        // NOT the ref named "".
                        upstream: None,
                    }
                ),
            ]
        );
    }

    #[test]
    fn ref_info_keeps_a_branch_name_containing_a_pipe_in_one_field() {
        // The reason the separator is NUL: any printable delimiter can appear
        // in a branch name and would split the record into bogus fields.
        let out = "refs/heads/feat|weird\x001700000000\x00iso\x00\n";
        assert_eq!(parse_ref_info(out)[0].0, "feat|weird");
    }

    #[test]
    fn ref_info_keys_stay_exact_when_a_tag_shares_the_branch_name() {
        // What it guarantees: a repository holding both `refs/heads/release`
        // and `refs/tags/release` still yields the key `release`.
        //
        // This is why the format asks for `%(refname)` and strips the prefix
        // here. git's own `%(refname:short)` is ambiguity-aware and shortens
        // that branch to `heads/release` instead, which would never match the
        // branch name the caller looked up — the row would silently lose its
        // AGE and its upstream.
        let out =
            "refs/heads/release\x001700000000\x00iso\x00refs/remotes/origin/release\x00origin\n";
        let parsed = parse_ref_info(out);
        assert_eq!(parsed[0].0, "release");
        assert_eq!(parsed[0].1.upstream.as_deref(), Some("release"));
    }

    #[test]
    fn upstream_from_a_local_branch_keeps_its_whole_name() {
        // What it guarantees: `branch.<b>.remote=.` (a LOCAL upstream) does not
        // lose its first path segment. `%(upstream:short)` renders this as
        // `release/2.0`, which is indistinguishable from remote `release` +
        // branch `2.0`; stripping there would report the BASE as `2.0` — a
        // wrong branch name presented as fact.
        assert_eq!(
            upstream_branch_name("refs/heads/release/2.0", "."),
            Some("release/2.0".to_string())
        );
    }

    #[test]
    fn upstream_from_a_remote_strips_exactly_that_remote() {
        assert_eq!(
            upstream_branch_name("refs/remotes/origin/develop", "origin"),
            Some("develop".to_string())
        );
        // A branch name containing slashes keeps all of them.
        assert_eq!(
            upstream_branch_name("refs/remotes/origin/release/next", "origin"),
            Some("release/next".to_string())
        );
    }

    #[test]
    fn upstream_handles_a_remote_name_containing_a_slash() {
        // `git remote add foo/bar <url>` is ACCEPTED, so the remote is not
        // reliably a single path segment. Taking the name from git rather than
        // splitting on the first `/` is what makes this exact — a naive split
        // would report `bar/develop`.
        assert_eq!(
            upstream_branch_name("refs/remotes/foo/bar/develop", "foo/bar"),
            Some("develop".to_string())
        );
    }

    #[test]
    fn upstream_is_none_when_the_branch_tracks_nothing() {
        assert_eq!(upstream_branch_name("", ""), None);
    }

    #[test]
    fn upstream_is_none_for_a_ref_outside_both_namespaces() {
        // Neither a local branch nor a remote-tracking ref: degrade to unknown
        // rather than display something that was never interpreted.
        assert_eq!(upstream_branch_name("refs/tags/v1", "origin"), None);
        // A remote-tracking ref whose remote name does not actually prefix it
        // cannot be split safely either.
        assert_eq!(
            upstream_branch_name("refs/remotes/other/develop", "origin"),
            None
        );
        // Nothing left after the remote name is not a branch.
        assert_eq!(upstream_branch_name("refs/remotes/origin/", "origin"), None);
    }

    #[test]
    fn ref_info_resolves_a_local_upstream_end_to_end() {
        // The parser path, not just the helper: a local upstream must survive
        // the whole record parse intact.
        let out = "refs/heads/feat/x\x001700000000\x00iso\x00refs/heads/release/2.0\x00.\n";
        assert_eq!(
            parse_ref_info(out)[0].1.upstream.as_deref(),
            Some("release/2.0")
        );
    }

    #[test]
    fn ref_info_ignores_a_record_outside_the_branch_namespace() {
        // Only `refs/heads/` patterns are ever asked for, so anything else is
        // not a branch this listing can key on.
        let out = "refs/tags/v1\x001700000000\x00iso\x00\n";
        assert!(parse_ref_info(out).is_empty());
    }

    #[test]
    fn ref_info_skips_a_record_it_cannot_model() {
        // A malformed record degrades to "age unknown" for that branch rather
        // than failing the whole listing.
        let out = "refs/heads/main\x00not-a-number\x00iso\x00\n\
                   refs/heads/good\x001700000000\x00iso\x00\n";
        let parsed = parse_ref_info(out);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].0, "good");
    }

    #[test]
    fn ref_info_of_no_branches_asks_git_nothing() {
        // `for-each-ref` with no patterns enumerates EVERY ref, so the call must
        // be skipped rather than issued with an empty operand list.
        let git = ScriptedGit::new(&[]);
        assert_eq!(branch_ref_info(&git, &[]).unwrap(), Vec::new());
    }

    #[test]
    fn ref_info_fully_qualifies_every_branch_operand() {
        // What it guarantees: a branch named like a flag arrives as a pattern,
        // not as an option git would parse.
        struct Recorder(std::cell::RefCell<Vec<String>>);
        impl GitRunner for Recorder {
            fn run(&self, args: &[&str]) -> Result<String> {
                *self.0.borrow_mut() = args.iter().map(|a| a.to_string()).collect();
                Ok(String::new())
            }
        }
        let git = Recorder(std::cell::RefCell::new(Vec::new()));
        branch_ref_info(&git, &["--format=%(objectname)".to_string()]).unwrap();
        let args = git.0.borrow().clone();
        assert_eq!(args[0], "for-each-ref");
        assert!(
            args[1].starts_with("--format=%(refname)%00"),
            "the key must come from the FULL refname, not %(refname:short): {:?}",
            args[1]
        );
        assert_eq!(args[2], "refs/heads/--format=%(objectname)");
    }

    #[test]
    fn detached_head_info_parses_the_log_output() {
        let git = ScriptedGit::new(&[(
            &["-C", "/repo/det", "log", "-1", "--format=%ct%x00%cI"],
            "1700000000\u{0}2023-11-14T22:13:20+00:00",
        )]);
        assert_eq!(
            detached_head_info(&git, "/repo/det"),
            Some((1_700_000_000, "2023-11-14T22:13:20+00:00".to_string()))
        );
    }

    #[test]
    fn detached_head_info_is_none_when_git_fails() {
        // An unborn HEAD or a broken worktree must degrade to "unknown", not
        // propagate an error that would kill the listing.
        let git = ScriptedGit::new(&[]);
        assert_eq!(detached_head_info(&git, "/repo/det"), None);
    }

    #[test]
    fn worktree_status_asks_for_the_pinned_porcelain_version() {
        // `--porcelain` alone means "the default version", which git documents
        // as subject to change; a silent switch to v2 would change the record
        // shape under `count_status_entries_z`.
        let git = LsFilesGit::new("");
        worktree_status_z(&git, "/repo/x").unwrap();
        assert_eq!(
            git.recorded_args(),
            vec![
                "-C",
                "/repo/x",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=normal",
            ]
        );
    }

    #[test]
    fn worktree_status_pins_untracked_reporting_against_user_config() {
        // What it guarantees: `status.showUntrackedFiles=no` — a real setting
        // people use to speed up `git status` in large repositories — cannot
        // make a worktree holding nothing but new files report as clean. The
        // flag is passed explicitly so the answer does not depend on config.
        let git = LsFilesGit::new("");
        worktree_status_z(&git, "/repo/x").unwrap();
        assert!(
            git.recorded_args()
                .contains(&"--untracked-files=normal".to_string()),
            "the untracked-files mode must be pinned, got: {:?}",
            git.recorded_args()
        );
    }

    #[test]
    fn null_oid_is_not_a_resolved_object_at_either_hash_width() {
        // What it guarantees: a worktree whose branch has no commits yet is
        // recognised as having no HEAD. git reports that as the NULL OID, not
        // as an empty field, and the width follows the repository's hash
        // algorithm — 40 zeros for SHA-1, 64 for a `--object-format=sha256`
        // repository. Both are verified against real `git worktree list`.
        assert!(!is_resolved_oid(&"0".repeat(40)));
        assert!(!is_resolved_oid(&"0".repeat(64)));
        // Empty: no `HEAD` record at all.
        assert!(!is_resolved_oid(""));
    }

    #[test]
    fn a_real_sha_is_a_resolved_object() {
        assert!(is_resolved_oid("93b07da74523635ff88ed6f5f17ea93a98e81bde"));
        // A sha that merely BEGINS with zeros is a perfectly ordinary object,
        // which is why the check is "every byte", not "starts with zero".
        assert!(is_resolved_oid("0000000000000000000000000000000000000001"));
    }

    #[test]
    fn parse_worktree_list_keeps_the_head_sha() {
        // The sha is already in the porcelain; keeping it avoids a second
        // resolution that could disagree with the listing.
        let out = "worktree /repo/main\nHEAD abc123\nbranch refs/heads/main\n\n";
        assert_eq!(parse_worktree_list(out)[0].head, "abc123");
    }

    #[test]
    fn parse_worktree_list_leaves_head_empty_when_absent() {
        let out = "worktree /repo/main\nbranch refs/heads/main\n\n";
        assert_eq!(parse_worktree_list(out)[0].head, "");
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
