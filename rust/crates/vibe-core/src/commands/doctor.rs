//! `vibe doctor`: detect stale (pre-2.2.0) nushell / PowerShell shell wrappers.
//!
//! The nushell and PowerShell wrappers shipped before vibe 2.2.0 were
//! structurally broken (see `docs/specifications/eval-contract.md` §6.1), and
//! vibe never rewrites a user's shell configuration — so a user who pasted the
//! old snippet keeps the broken behaviour indefinitely, with no signal. This
//! command reads the well-known nushell/PowerShell profile locations and
//! classifies any `vibe` wrapper it finds as current or stale, printing the fix.
//!
//! Deliberate clig.dev deviation: a `doctor` report conventionally goes to
//! stdout, but in this CLI stdout IS the shell-eval channel — the POSIX wrapper
//! runs `eval "$(command vibe ...)"`, so a report printed there would be
//! *executed* as shell source. Every line therefore goes to stderr via the
//! output helpers, and the [`Outcome`] carries nothing.
//!
//! The report lines use `report_log`/`warn_log`, both of which ignore `--quiet`:
//! a stale finding exits 1, and `vibe doctor -q` exiting 1 with no explanation
//! would be actively misleading. The warning color is reserved for the findings
//! themselves, so a clean report does not read as a problem.
//!
//! Profile files are NOT trust-verified (`vibe trust` / SHA-256). Trust gates
//! *execution* of a config file; doctor never executes anything, it only reads
//! bytes to classify them. Requiring trust here would mean a user could not
//! diagnose their own shell rc file, which is the entire point of the command.
//!
//! Known limitation: on Windows, OneDrive's Known Folder redirection can move
//! `Documents` somewhere this command does not look. `%OneDrive%\Documents` is
//! probed when that variable is set, but a redirection to an arbitrary folder
//! (or a wrapper sourced from a file included by the profile) is invisible —
//! hence the closing hint pointing at `vibe shell-setup`.
//!
//! Exit-code contract: 0 when nothing stale was found (including "no wrapper
//! anywhere"), 1 (via [`VibeError::AlreadyReported`], so the binary prints no
//! extra `Error:` line) when at least one stale wrapper was found.

use crate::commands::shell_setup::ShellName;
use crate::commands::Outcome;
use crate::error::{Result, VibeError};
use crate::io::Io;
use crate::output::{report_log, sanitize_for_display, verbose_log, warn_log, OutputOptions};
use std::path::{Component, Path, PathBuf};

/// 1 MB cap on a profile file read (resource-exhaustion guard).
pub const MAX_PROFILE_SIZE: usize = 1024 * 1024;

/// The outcome of trying to read one candidate profile file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileRead {
    /// The file was read. `truncated` is true when it exceeded the size cap and
    /// only the leading `MAX_PROFILE_SIZE` bytes were classified.
    Present { content: String, truncated: bool },
    /// The path does not exist.
    Missing,
    /// The path exists but could not be read (permissions, I/O error).
    Unreadable,
    /// The path exists but is not a regular file (directory, FIFO, device, ...).
    Rejected,
}

/// Reads candidate profile files. Injected so the classifier and the report are
/// unit-testable without touching a real home directory.
pub trait ProfileFs {
    fn read_profile(&self, path: &Path) -> ProfileRead;
}

/// Production [`ProfileFs`] over the real filesystem.
pub struct RealProfileFs;

impl ProfileFs for RealProfileFs {
    /// Type-gate first, then a capped read.
    ///
    /// Why `metadata` (which follows symlinks) rather than `symlink_metadata`:
    /// dotfile managers routinely symlink `config.nu` / `$PROFILE` into a
    /// checkout, and refusing to follow the link would report every such user's
    /// working setup as unreadable. Following is safe here precisely because the
    /// bytes are only classified, never executed. The `is_file` check rejects the
    /// obvious hazards up front (a FIFO or character device would block forever
    /// or read from hardware), and the `take` cap below is the real backstop: the
    /// path could be swapped between the `metadata` and the `open`, so the bound
    /// has to live on the read itself rather than on the type check.
    ///
    /// Why a capped read instead of a metadata size pre-check: the size can
    /// change between the two syscalls, and a growing/streaming file would defeat
    /// the check. `take(cap + 1)` bounds the read itself.
    fn read_profile(&self, path: &Path) -> ProfileRead {
        use std::io::Read;

        let meta = match std::fs::metadata(path) {
            Ok(meta) => meta,
            // Only a genuine absence is `Missing`. EACCES on a parent directory,
            // ELOOP on a symlink cycle and friends mean the file may well exist
            // and we simply could not look at it — reporting that as "no such
            // profile" would hide the very thing the user asked us to check.
            Err(error) => {
                let is_absent = error.kind() == std::io::ErrorKind::NotFound;
                return if is_absent {
                    ProfileRead::Missing
                } else {
                    ProfileRead::Unreadable
                };
            }
        };
        if !meta.is_file() {
            return ProfileRead::Rejected;
        }

        let Ok(file) = std::fs::File::open(path) else {
            return ProfileRead::Unreadable;
        };
        let mut buf = Vec::new();
        let mut handle = file.take((MAX_PROFILE_SIZE as u64) + 1);
        if handle.read_to_end(&mut buf).is_err() {
            return ProfileRead::Unreadable;
        }

        let truncated = buf.len() > MAX_PROFILE_SIZE;
        if truncated {
            buf.truncate(MAX_PROFILE_SIZE);
        }
        ProfileRead::Present {
            content: String::from_utf8_lossy(&buf).into_owned(),
            truncated,
        }
    }
}

/// How a profile file's `vibe` wrapper (if any) classifies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WrapperStatus {
    /// No `vibe` wrapper definition in the file.
    NoWrapper,
    /// A wrapper that requests its `--eval-dialect` (2.2.0 or later).
    Current,
    /// A wrapper with no dialect request — the pre-2.2.0, broken form.
    Stale,
}

/// Whether an environment-derived directory root is safe to build a path from.
///
/// Mirrors [`crate::config_path::config_dir`]'s HOME predicate (non-empty,
/// absolute, no `..` component) and adds a Windows-only prefix restriction:
/// only a drive prefix is accepted, so a `\\server\share` (UNC) or
/// `\\.\pipe\...` (device namespace) value cannot make this command reach out
/// over SMB or block on a named pipe.
fn is_safe_root(root: &str) -> bool {
    let path = Path::new(root);

    let is_non_empty = !root.is_empty();
    let is_absolute = path.is_absolute();
    let has_parent_dir = path.components().any(|c| matches!(c, Component::ParentDir));
    let has_safe_prefix = has_safe_prefix(path);

    is_non_empty && is_absolute && !has_parent_dir && has_safe_prefix
}

#[cfg(windows)]
fn has_safe_prefix(path: &Path) -> bool {
    use std::path::Prefix;
    match path.components().next() {
        Some(Component::Prefix(prefix)) => matches!(prefix.kind(), Prefix::Disk(_)),
        _ => false,
    }
}

// Unix paths carry no prefix component at all, so absoluteness is the whole test.
#[cfg(not(windows))]
fn has_safe_prefix(_path: &Path) -> bool {
    true
}

/// A validated environment root, or `None` when the variable is unset/unsafe.
fn safe_root(io: &impl Io, key: &str) -> Option<PathBuf> {
    let value = io.env(key)?;
    if !is_safe_root(&value) {
        return None;
    }
    Some(PathBuf::from(value))
}

/// The nushell + PowerShell profile paths to inspect, in report order.
///
/// `is_windows` is passed in (not `cfg!`) because vibe-core stays free of
/// `cfg(target_os)`: the binary supplies the platform fact, and both branches
/// stay unit-testable on any host.
fn candidate_profiles(io: &impl Io, is_windows: bool) -> Vec<(ShellName, PathBuf)> {
    if is_windows {
        return windows_profiles(io);
    }
    unix_profiles(io)
}

fn unix_profiles(io: &impl Io) -> Vec<(ShellName, PathBuf)> {
    // XDG_CONFIG_HOME wins when set and safe; otherwise ~/.config.
    let config_home = safe_root(io, "XDG_CONFIG_HOME")
        .or_else(|| safe_root(io, "HOME").map(|home| home.join(".config")));
    let Some(config_home) = config_home else {
        return Vec::new();
    };

    let mut out = vec![(
        ShellName::Nushell,
        config_home.join("nushell").join("config.nu"),
    )];
    let pwsh_dir = config_home.join("powershell");
    for name in PWSH_PROFILE_NAMES {
        out.push((ShellName::Powershell, pwsh_dir.join(name)));
    }
    out
}

fn windows_profiles(io: &impl Io) -> Vec<(ShellName, PathBuf)> {
    let mut out = Vec::new();

    if let Some(appdata) = safe_root(io, "APPDATA") {
        out.push((
            ShellName::Nushell,
            appdata.join("nushell").join("config.nu"),
        ));
    }

    // pwsh 7 uses Documents\PowerShell; Windows PowerShell 5.1 uses
    // Documents\WindowsPowerShell. Both are checked: a user may have pasted the
    // wrapper into either, and a stale wrapper is worth reporting in both.
    let documents_roots = ["USERPROFILE", "OneDrive"]
        .iter()
        .filter_map(|key| safe_root(io, key))
        .map(|root| root.join("Documents"));
    for documents in documents_roots {
        for dir in ["PowerShell", "WindowsPowerShell"] {
            for name in PWSH_PROFILE_NAMES {
                out.push((ShellName::Powershell, documents.join(dir).join(name)));
            }
        }
    }

    out
}

/// PowerShell reads the host-specific profile and the all-hosts `profile.ps1`;
/// the wrapper can legitimately live in either.
const PWSH_PROFILE_NAMES: [&str; 2] = ["Microsoft.PowerShell_profile.ps1", "profile.ps1"];

/// The `--eval-dialect` request that marks a post-2.2.0 wrapper, per shell.
fn dialect_marker(shell: ShellName) -> &'static str {
    match shell {
        ShellName::Nushell => "--eval-dialect nu",
        _ => "--eval-dialect powershell",
    }
}

/// Whether `line` opens a `vibe` wrapper definition for `shell`.
///
/// The command NAME is compared as a whole token, never as a substring. A
/// `contains("vibe")` test misfires on every helper that merely *calls* vibe
/// (`def wt [] { ^vibe start }`) and on every name that merely starts with it
/// (`def vibe-clean`, `function vibe-helper`) — each of which would be reported
/// as a stale wrapper with a "Fix:" line telling the user to replace a function
/// that is perfectly fine.
fn is_wrapper_definition(line: &str, shell: ShellName) -> bool {
    let code = strip_trailing_comment(line);
    match shell {
        // nu command names ARE case-sensitive: `def Vibe` defines a different
        // command, and the shipped wrapper is lowercase.
        ShellName::Nushell => nushell_def_name(code) == Some("vibe"),
        // PowerShell function names are case-INSENSITIVE, so `function Vibe`
        // really does override `vibe` and must be classified.
        _ => powershell_function_name(code).is_some_and(|name| name.eq_ignore_ascii_case("vibe")),
    }
}

/// The command name of a nushell `def`, e.g. `def --env --wrapped vibe [...]`
/// → `vibe`. `None` when the line is not a `def`.
///
/// Flag tokens between the keyword and the name are skipped, which covers both
/// the current `--env --wrapped` form and the old `--env` one.
fn nushell_def_name(code: &str) -> Option<&str> {
    let mut tokens = code.split_whitespace();
    let is_def = tokens.next()? == "def";
    if !is_def {
        return None;
    }
    let name = tokens.find(|token| !token.starts_with("--"))?;
    // `def vibe[...]` (no space before the signature) is legal nu.
    Some(name.split(['[', '{']).next().unwrap_or(name))
}

/// The function name of a PowerShell `function`, e.g. `function vibe {` →
/// `vibe`. `None` when the line is not a `function`.
///
/// Case-insensitive on the KEYWORD only (PowerShell keywords are), but the name
/// is returned verbatim; `vibe` is what `shell-setup` emits and what the wrapper
/// must be called for PowerShell to resolve it.
fn powershell_function_name(code: &str) -> Option<&str> {
    let mut tokens = code.split_whitespace();
    let is_function = tokens.next()?.eq_ignore_ascii_case("function");
    if !is_function {
        return None;
    }
    let name = tokens.next()?;
    // `function vibe{` / `function vibe(` need splitting off the delimiter.
    Some(name.split(['{', '(']).next().unwrap_or(name))
}

/// Classify the `vibe` wrapper in `content`, if any.
///
/// Line-based rather than regex: the shapes are one-line definitions with a
/// brace body, and a regex over untrusted rc-file text would be both harder to
/// audit and a backtracking risk on a 1 MB input.
///
/// The dialect marker is searched only inside the wrapper's own brace block. A
/// whole-file search would let an unrelated comment (or a stale wrapper's own
/// "replace this with --eval-dialect nu" note) mask a genuinely broken wrapper.
/// When a file defines several wrappers, stale wins: any broken definition may
/// be the one that is actually in effect.
pub(crate) fn classify(content: &str, shell: ShellName) -> WrapperStatus {
    let mut found_any = false;

    let lines: Vec<&str> = content.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        if is_comment(line) {
            continue;
        }
        if !is_wrapper_definition(line, shell) {
            continue;
        }
        found_any = true;
        let is_current = block_contains_marker(&lines[index..], dialect_marker(shell), shell);
        if !is_current {
            return WrapperStatus::Stale;
        }
    }

    if found_any {
        WrapperStatus::Current
    } else {
        WrapperStatus::NoWrapper
    }
}

/// A `#`-comment line (both nu and PowerShell use `#`).
fn is_comment(line: &str) -> bool {
    line.trim_start().starts_with('#')
}

/// `line` with any trailing `#`-comment removed.
///
/// Why the naive split on the first `#`: a `#` inside a string literal
/// (`print "a#b"`) is truncated too, so the code region can come out short. That
/// is the safe direction — a marker we fail to see makes a wrapper look STALE,
/// which prints a fix for an already-correct wrapper, whereas a marker we
/// wrongly *accept* from a comment silently blesses a broken one. Full nu /
/// PowerShell string-literal parsing is out of scope for a classifier over
/// user-local config; the closing "compare with `vibe shell-setup`" hint covers
/// the residue.
fn strip_trailing_comment(line: &str) -> &str {
    match line.find('#') {
        Some(at) => &line[..at],
        None => line,
    }
}

/// Whether `marker` appears inside the brace block opened by the definition on
/// `lines[0]`.
///
/// Restricting the search to the block's own character region is what keeps a
/// marker that lives OUTSIDE it — in a trailing comment, or in a statement after
/// the closing brace (`... } ; print '--eval-dialect nu'`) — from blessing a
/// stale wrapper. Comments are stripped first, then the marker is only accepted
/// while brace depth is ≥ 1.
///
/// The scan is bounded three ways: the matching close brace, the next wrapper
/// definition, and [`MAX_BLOCK_SEARCH_LINES`]. Without the last two, an
/// unbalanced brace inside a string literal (which this classifier deliberately
/// does not parse — see [`strip_trailing_comment`]) would let the scan run to end
/// of file and pick up an unrelated marker.
///
/// A marker is only honoured once the block is known to CLOSE. An unbalanced
/// block has no determinable extent, so a marker found inside the assumed region
/// could belong to unrelated code below; the wrapper is then reported stale,
/// which prints a fix for a possibly-correct wrapper — the safe direction, since
/// the alternative is silently blessing a broken one.
fn block_contains_marker(lines: &[&str], marker: &str, shell: ShellName) -> bool {
    let mut depth = 0usize;
    let mut opened = false;
    let mut seen_marker = false;

    for (index, line) in lines.iter().take(MAX_BLOCK_SEARCH_LINES).enumerate() {
        if is_comment(line) {
            continue;
        }
        // A following definition means this block never closed cleanly; stop
        // rather than absorb the next wrapper's marker.
        let is_following_definition = index > 0 && is_wrapper_definition(line, shell);
        if is_following_definition {
            return false;
        }

        let code = strip_trailing_comment(line);
        let (region, closed) = block_region(code, &mut depth, &mut opened);
        seen_marker = seen_marker || region.contains(marker);
        if closed {
            return seen_marker;
        }
    }
    false
}

/// How far past the definition line the block scan may run.
///
/// Generous enough for any hand-formatted wrapper (the documented multi-line nu
/// form is 7 lines, and Allman adds one) while keeping an unbalanced brace from
/// turning the scan into a whole-file search.
const MAX_BLOCK_SEARCH_LINES: usize = 40;

/// The part of `code` that lies inside the wrapper's brace block, advancing
/// `depth`/`opened` across lines. Returns `(region, block_closed_here)`.
///
/// Before the opening `{` and after the matching `}` the text is not part of the
/// block, so it is excluded from the returned slice — that is precisely what
/// stops a post-`}` statement on the same line from counting as a marker.
fn block_region<'a>(code: &'a str, depth: &mut usize, opened: &mut bool) -> (&'a str, bool) {
    let mut region_start = if *opened { 0 } else { code.len() };
    let mut region_end = code.len();
    let mut closed_here = false;

    for (at, c) in code.char_indices() {
        match c {
            '{' => {
                let is_opening_brace = !*opened;
                if is_opening_brace {
                    *opened = true;
                    region_start = at + c.len_utf8();
                }
                *depth += 1;
            }
            '}' => {
                *depth = depth.saturating_sub(1);
                let block_closed = *opened && *depth == 0;
                if block_closed {
                    region_end = at;
                    closed_here = true;
                    break;
                }
            }
            _ => {}
        }
    }

    let region = code
        .get(region_start.min(region_end)..region_end)
        .unwrap_or("");
    (region, closed_here)
}

/// One report row: what was checked and what was found.
struct Finding {
    shell: ShellName,
    path: PathBuf,
    status: &'static str,
    is_stale: bool,
    truncated: bool,
}

/// Report status strings. A closed set of `&'static str` rather than formatted
/// text, so no file content can ever reach the status column.
const STATUS_CURRENT: &str = "current";
const STATUS_STALE: &str = "stale";
const STATUS_NO_WRAPPER: &str = "no vibe wrapper";
const STATUS_NOT_REGULAR_FILE: &str = "not checked (not a regular file)";
const STATUS_UNREADABLE: &str = "unreadable";

/// Run `vibe doctor`.
pub fn doctor_command(
    io: &impl Io,
    fs: &impl ProfileFs,
    is_windows: bool,
    opts: OutputOptions,
) -> Result<Outcome> {
    let candidates = candidate_profiles(io, is_windows);

    // Absent profiles are omitted from the report (they are not findings), but
    // "doctor said nothing about my file" is exactly the confusing case, so
    // --verbose names every path that was actually looked at.
    for (_, path) in &candidates {
        verbose_log(
            io,
            &format!("checking {}", sanitize_for_display(&path.to_string_lossy())),
            opts,
        );
    }

    let findings: Vec<Finding> = candidates
        .into_iter()
        .filter_map(|(shell, path)| inspect(fs, shell, path))
        .collect();

    // `report_log`/`warn_log` (not `log`) so the report survives `--quiet`: a
    // stale finding exits 1, and exiting 1 in silence would be unexplainable.
    // Yellow is reserved for the findings themselves.
    report_log(io, "Checking shell wrappers for nushell and PowerShell...");

    if findings.is_empty() {
        report_log(io, "  No nushell or PowerShell profile found.");
    }
    for finding in &findings {
        // Never echo file content, and never interpolate a raw io::Error (its
        // Display embeds the unsanitized path on some platforms).
        let path = sanitize_for_display(&finding.path.to_string_lossy());
        let line = format!("  {}: {}", path, finding.status);
        if finding.is_stale {
            warn_log(io, &line);
        } else {
            report_log(io, &line);
        }
        if finding.truncated {
            report_log(io, "    (file too large; checked first 1 MB)");
        }
        // The fix goes directly under its own row: with two stale profiles, a
        // trailing block of Fix lines leaves the reader matching paths by eye.
        if finding.is_stale {
            warn_log(
                io,
                &format!(
                    "    Fix: run 'vibe shell-setup --shell {}' and replace the vibe function in {}",
                    finding.shell.as_str(),
                    path
                ),
            );
        }
    }

    let has_stale = findings.iter().any(|f| f.is_stale);

    report_log(
        io,
        "If your wrapper is sourced from another file, compare it with \
         'vibe shell-setup --shell <nushell|powershell>'.",
    );

    if !has_stale {
        return Ok(Outcome::none());
    }
    // The report above IS the diagnostic; AlreadyReported carries exit 1 without
    // the binary appending a second, contentless `Error:` line.
    Err(VibeError::AlreadyReported)
}

/// Read + classify one candidate, or `None` when the path simply does not exist
/// (an absent profile is not a finding worth a report row).
fn inspect(fs: &impl ProfileFs, shell: ShellName, path: PathBuf) -> Option<Finding> {
    let (status, is_stale, truncated) = match fs.read_profile(&path) {
        ProfileRead::Missing => return None,
        ProfileRead::Rejected => (STATUS_NOT_REGULAR_FILE, false, false),
        ProfileRead::Unreadable => (STATUS_UNREADABLE, false, false),
        ProfileRead::Present { content, truncated } => match classify(&content, shell) {
            WrapperStatus::Current => (STATUS_CURRENT, false, truncated),
            WrapperStatus::Stale => (STATUS_STALE, true, truncated),
            WrapperStatus::NoWrapper => (STATUS_NO_WRAPPER, false, truncated),
        },
    };
    Some(Finding {
        shell,
        path,
        status,
        is_stale,
        truncated,
    })
}

#[cfg(test)]
#[path = "doctor_tests.rs"]
mod tests;
