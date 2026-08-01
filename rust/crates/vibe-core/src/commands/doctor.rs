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
//! Known limitations:
//!
//! - On Windows, OneDrive's Known Folder redirection can move `Documents`
//!   somewhere this command does not look. `%OneDrive%\Documents` is probed when
//!   that variable is set, but a redirection to an arbitrary folder (or a wrapper
//!   sourced from a file included by the profile) is invisible — hence the
//!   closing hint pointing at `vibe shell-setup`.
//! - The classifier masks string literals and PowerShell `<# #>` block comments
//!   before it counts braces or looks for the dialect flag (see [`mask_line`]),
//!   which is what keeps a `}` or a `--eval-dialect` inside quotes from deciding
//!   the verdict. Two constructs are still not modeled: strings that span lines,
//!   and here-strings (`@"..."@`, nu `r#'...'#`). Quote state resets at every
//!   newline, so an unterminated quote blanks the remainder of that line only —
//!   the masked tail loses its braces, the block fails to close, and the wrapper
//!   reads `stale` or `could not determine`. Both residual cases therefore fail
//!   toward reporting a problem, never toward blessing a broken wrapper.
//! - Profile bytes are decoded from UTF-8, or from UTF-16 when a byte-order mark
//!   says so (see [`decode_profile_bytes`]); a BOM-less UTF-16 profile is not
//!   detected.
//!
//! Exit-code contract: 0 when nothing stale was found (including "no wrapper
//! anywhere" and "the block was too long to classify"), 1 when at least one stale
//! wrapper was found (via [`VibeError::AlreadyReported`], so the binary prints no
//! extra `Error:` line) or when no usable profile root exists at all (via
//! [`VibeError::Configuration`], whose `Error:` line IS the whole explanation —
//! no report was printed in that case).
//!
//! Note that the POSIX wrappers run vibe inside `eval "$(command vibe ...)"`,
//! which discards the binary's exit code, and the nushell wrapper aborts the
//! calling script on a non-zero external exit. A script that wants to observe
//! doctor's exit code must bypass the wrapper (`command vibe doctor`,
//! `^vibe doctor`, `vibe.exe doctor`).

use crate::commands::shell_setup::ShellName;
use crate::commands::Outcome;
use crate::error::{Result, VibeError};
use crate::io::Io;
use crate::output::{report_log, sanitize_for_display, verbose_log, warn_log, OutputOptions};
use crate::shell::{EvalDialect, EVAL_DIALECT_FLAG};
use std::path::{Path, PathBuf};

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
            content: decode_profile_bytes(&buf),
            truncated,
        }
    }
}

/// Decode profile bytes to text, honouring a byte-order mark.
///
/// PowerShell's own tooling still writes UTF-16LE with a BOM (`Out-File` defaulted
/// to it through Windows PowerShell 5.1, and `notepad.exe` offers it), and a
/// UTF-8 BOM is what many Windows editors add on save. Decoding those as UTF-8
/// yields text where every ASCII character is followed by a NUL — no line of which
/// matches `function vibe`, so a genuinely stale wrapper would be reported as
/// `no vibe wrapper`, i.e. silently clean. That is the one failure direction this
/// command must not have.
///
/// Why not sniff BOM-less UTF-16 (the "every other byte is NUL" heuristic): it is
/// a guess about untrusted bytes, and no shell writes such a profile by default.
/// The BOM cases cover the encodings the platform tooling actually produces.
fn decode_profile_bytes(buf: &[u8]) -> String {
    const BOM_UTF8: [u8; 3] = [0xEF, 0xBB, 0xBF];
    const BOM_UTF16_LE: [u8; 2] = [0xFF, 0xFE];
    const BOM_UTF16_BE: [u8; 2] = [0xFE, 0xFF];

    if let Some(rest) = buf.strip_prefix(&BOM_UTF8) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Some(rest) = buf.strip_prefix(&BOM_UTF16_LE) {
        return decode_utf16(rest, u16::from_le_bytes);
    }
    if let Some(rest) = buf.strip_prefix(&BOM_UTF16_BE) {
        return decode_utf16(rest, u16::from_be_bytes);
    }
    String::from_utf8_lossy(buf).into_owned()
}

/// UTF-16 code units in `order`'s byte order, lossily decoded. A trailing odd
/// byte (a truncated read cutting a code unit in half) is dropped by
/// `chunks_exact`.
fn decode_utf16(bytes: &[u8], order: fn([u8; 2]) -> u16) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| order([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
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
    /// A wrapper whose brace block ran past the scan cap, so neither verdict can
    /// be justified. Reported, but not a failure.
    Indeterminate,
}

/// Whether an environment-derived directory root is safe to build a path from.
///
/// Reuses [`crate::config_path::is_valid_abs_root`] (non-empty, absolute, no `..`
/// component) rather than restating the predicate, so doctor and the settings
/// store cannot drift apart on which HOME values are usable. On top of it sits a
/// Windows-only prefix restriction: only a drive prefix is accepted, so a
/// `\\server\share` (UNC) or `\\.\pipe\...` (device namespace) value cannot make
/// this command reach out over SMB or block on a named pipe.
fn is_safe_root(root: &str) -> bool {
    crate::config_path::is_valid_abs_root(root) && has_safe_prefix(Path::new(root))
}

#[cfg(windows)]
fn has_safe_prefix(path: &Path) -> bool {
    use std::path::{Component, Prefix};
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

/// The host facts this command branches on.
///
/// Passed in (not `cfg!`) because vibe-core stays free of `cfg(target_os)`: the
/// binary supplies the platform facts, and every branch stays unit-testable on
/// any host.
#[derive(Debug, Clone, Copy, Default)]
pub struct HostPlatform {
    pub is_windows: bool,
    pub is_macos: bool,
}

/// The candidate profiles, plus the env vars that were skipped for being set to
/// an unusable value.
struct CandidateSet {
    profiles: Vec<(ShellName, PathBuf)>,
    /// Variable NAMES only. The values are attacker-influenceable and are never
    /// printed; naming the variable is enough for the user to go look at it.
    skipped_roots: Vec<&'static str>,
}

/// A validated environment root.
///
/// Returns `None` for both "unset" and "unsafe", and pushes `key` onto `skipped`
/// only in the second case: an unset `OneDrive` (or `XDG_CONFIG_HOME`) is the
/// normal state on most machines, so reporting it as skipped would make a healthy
/// setup look broken.
fn safe_root(io: &impl Io, key: &'static str, skipped: &mut Vec<&'static str>) -> Option<PathBuf> {
    let value = io.env(key)?;
    if !is_safe_root(&value) {
        skipped.push(key);
        return None;
    }
    Some(PathBuf::from(value))
}

/// The nushell + PowerShell profile paths to inspect, in report order.
fn candidate_profiles(io: &impl Io, platform: HostPlatform) -> CandidateSet {
    let mut skipped = Vec::new();
    let profiles = if platform.is_windows {
        windows_profiles(io, &mut skipped)
    } else {
        unix_profiles(io, platform, &mut skipped)
    };
    CandidateSet {
        profiles,
        skipped_roots: skipped,
    }
}

fn unix_profiles(
    io: &impl Io,
    platform: HostPlatform,
    skipped: &mut Vec<&'static str>,
) -> Vec<(ShellName, PathBuf)> {
    let home = safe_root(io, "HOME", skipped);
    let xdg = safe_root(io, "XDG_CONFIG_HOME", skipped);
    let dot_config = home.as_ref().map(|home| home.join(".config"));

    let mut out = Vec::new();

    // nu resolves its config dir from XDG_CONFIG_HOME when that is set, and falls
    // back to the platform default otherwise. Only the location nu would ACTUALLY
    // load is probed: reporting a stale leftover in a directory nu never reads
    // would exit 1 over a file that has no effect on the user's shell.
    let nu_config_home = xdg.clone().or_else(|| {
        // macOS nu defaults to the Apple convention, not to ~/.config.
        let apple_dir = home
            .as_ref()
            .map(|home| home.join("Library").join("Application Support"));
        if platform.is_macos {
            apple_dir
        } else {
            dot_config.clone()
        }
    });
    if let Some(dir) = nu_config_home {
        out.push((ShellName::Nushell, dir.join("nushell").join("config.nu")));
    }

    // PowerShell is the opposite case: .NET honours XDG_CONFIG_HOME when set, but
    // ~/.config is where the profile actually lives on a great many machines, so
    // BOTH are probed. One extra `metadata` call per profile name buys certainty
    // instead of a documented ambiguity.
    let pwsh_roots = [xdg, dot_config];
    let mut seen_pwsh_dirs: Vec<PathBuf> = Vec::new();
    for root in pwsh_roots.into_iter().flatten() {
        let pwsh_dir = root.join("powershell");
        // XDG_CONFIG_HOME is very often literally `$HOME/.config`; probing it
        // twice would print the same path as two report rows.
        let is_duplicate = seen_pwsh_dirs.contains(&pwsh_dir);
        if is_duplicate {
            continue;
        }
        seen_pwsh_dirs.push(pwsh_dir.clone());
        for name in PWSH_PROFILE_NAMES {
            out.push((ShellName::Powershell, pwsh_dir.join(name)));
        }
    }

    out
}

fn windows_profiles(io: &impl Io, skipped: &mut Vec<&'static str>) -> Vec<(ShellName, PathBuf)> {
    let mut out = Vec::new();

    if let Some(appdata) = safe_root(io, "APPDATA", skipped) {
        out.push((
            ShellName::Nushell,
            appdata.join("nushell").join("config.nu"),
        ));
    }

    // pwsh 7 uses Documents\PowerShell; Windows PowerShell 5.1 uses
    // Documents\WindowsPowerShell. Both are checked: a user may have pasted the
    // wrapper into either, and a stale wrapper is worth reporting in both.
    let documents_roots: Vec<PathBuf> = ["USERPROFILE", "OneDrive"]
        .iter()
        .filter_map(|key| safe_root(io, key, skipped))
        .map(|root| root.join("Documents"))
        .collect();
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

/// Whether `region` contains a `--eval-dialect` request naming `shell`'s dialect.
///
/// Why tokenize instead of `region.contains("--eval-dialect nu")`: a substring
/// test accepts any *prefix* extension of the value, so a wrapper passing
/// `--eval-dialect nub` (which the binary rejects, leaving the wrapper broken)
/// would be blessed as current. It also cannot see the equally valid
/// `--eval-dialect=nu` form or an alias like `pwsh`/`nushell`. Values are matched
/// exactly against [`EvalDialect::accepted_values`] — the same vocabulary clap
/// parses, drift-guarded by a test in the binary.
fn region_contains_dialect_marker(region: &str, shell: ShellName) -> bool {
    let dialect = match shell {
        ShellName::Nushell => EvalDialect::Nushell,
        _ => EvalDialect::Powershell,
    };
    let accepted = dialect.accepted_values();

    let mut tokens = region.split_whitespace();
    while let Some(token) = tokens.next() {
        // `--eval-dialect=nu` carries its value inline; `--eval-dialect nu`
        // carries it in the following token.
        let value = match token.strip_prefix(EVAL_DIALECT_FLAG) {
            // Bare flag: the value is the next token, and `None` here means the
            // flag was the region's last token.
            Some("") => tokens.next(),
            // Attached form: `None` here means either an empty `--eval-dialect=`
            // or a longer flag that merely starts the same way
            // (`--eval-dialectic`), neither of which carries a value to match.
            Some(rest) => rest.strip_prefix('='),
            None => continue,
        };
        let Some(value) = value else {
            continue;
        };
        // The wrapper embeds the flag in shell syntax, so the value token can
        // arrive wrapped in punctuation on either side: `(^vibe --eval-dialect
        // nu ...)`, `--eval-dialect "powershell"`, `--eval-dialect='nu'`. Trimmed
        // from BOTH ends — a leading quote is just as common as a trailing one,
        // and leaving it on would report a perfectly good wrapper as stale.
        let value = value.trim_matches([')', '(', '"', '\'', ';']);
        if accepted.contains(&value) {
            return true;
        }
    }
    false
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
///
/// A leading `export` is accepted: a user who keeps their wrapper in a nu module
/// must write `export def vibe`, and that definition is every bit as live (and as
/// stale) once the module is `use`d. Only `export def` is a definition, so
/// `export alias`, `export const` and `export-env` still fall through to `None`.
fn nushell_def_name(code: &str) -> Option<&str> {
    let mut tokens = code.split_whitespace().peekable();
    if tokens.peek() == Some(&"export") {
        tokens.next();
    }
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
///
/// A scope qualifier is stripped first: `function global:vibe { ... }` defines
/// the very same `vibe` command the wrapper occupies, so leaving the prefix on
/// would classify a genuinely stale wrapper as "no vibe wrapper" — silently
/// clean, the one direction this command must not have.
fn powershell_function_name(code: &str) -> Option<&str> {
    let mut tokens = code.split_whitespace();
    let is_function = tokens.next()?.eq_ignore_ascii_case("function");
    if !is_function {
        return None;
    }
    let name = tokens.next()?;
    // `function vibe{` / `function vibe(` need splitting off the delimiter.
    let name = name.split(['{', '(']).next().unwrap_or(name);
    Some(strip_powershell_scope(name))
}

/// PowerShell scope qualifiers that may prefix a function name.
const PWSH_SCOPES: [&str; 4] = ["global:", "script:", "local:", "private:"];

/// `global:vibe` → `vibe`. Names with no qualifier are returned untouched.
///
/// Matched with the colon included, so `globalvibe` (a different function that
/// merely starts with a scope word) keeps its full name and is correctly NOT
/// treated as the wrapper.
fn strip_powershell_scope(name: &str) -> &str {
    for scope in PWSH_SCOPES {
        let is_scoped = name.len() > scope.len() && name[..scope.len()].eq_ignore_ascii_case(scope);
        if is_scoped {
            return &name[scope.len()..];
        }
    }
    name
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
/// Priority when a file holds several wrappers: `Stale` > `Indeterminate` >
/// `Current` > `NoWrapper`. Stale short-circuits (a definite finding needs no
/// further evidence); an exhausted scan is remembered and the walk continues, so
/// a genuinely stale wrapper further down still wins.
pub(crate) fn classify(content: &str, shell: ShellName) -> WrapperStatus {
    let mut found_any = false;
    let mut any_indeterminate = false;

    let lines: Vec<&str> = content.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        if is_comment(line) {
            continue;
        }
        if !is_wrapper_definition(line, shell) {
            continue;
        }
        found_any = true;
        match scan_block(&lines[index..], shell) {
            BlockScan::ClosedWithMarker => {}
            BlockScan::ClosedWithoutMarker | BlockScan::NeverClosed => return WrapperStatus::Stale,
            BlockScan::Exhausted => any_indeterminate = true,
        }
    }

    if any_indeterminate {
        return WrapperStatus::Indeterminate;
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
/// Operates on an ALREADY-MASKED line (see [`mask_line`]), where string contents
/// and `<# #>` block comments have been blanked out. A `#` surviving into this
/// function is therefore genuinely a line comment, so the naive cut at the first
/// one is correct rather than merely tolerable.
///
/// Kept separate from the masking pass because `is_wrapper_definition` needs it
/// on raw text too, where the masker's shell-specific state is not available.
fn strip_trailing_comment(line: &str) -> &str {
    match line.find('#') {
        Some(at) => &line[..at],
        None => line,
    }
}

/// Carries the only masking state that survives across lines.
///
/// PowerShell's `<# ... #>` block comment is the one construct here that is
/// genuinely multi-line, and an open one must keep swallowing text (including a
/// stray `}` or a `--eval-dialect` note) until its `#>`. String quote state
/// deliberately does NOT persist — see [`mask_line`].
#[derive(Debug, Default, Clone, Copy)]
struct MaskState {
    in_block_comment: bool,
}

/// Blank out everything on `line` that is not executable code, preserving byte
/// offsets so the result can be used for brace counting and marker detection
/// alike.
///
/// Masked to spaces: string literal contents *and* their delimiters, and any
/// `<# ... #>` block comment (PowerShell only). Everything else is copied
/// through, so braces and flags in real code keep both their identity and their
/// position.
///
/// Why mask rather than truncate: the block scan needs ONE representation that is
/// correct for two different questions. A `}` inside `"..."` must not close the
/// wrapper's block, and a `--eval-dialect powershell` inside `"..."` or `<# #>`
/// must not bless it. Deleting the text would shift offsets; replacing it with
/// spaces keeps `block_region`'s slicing honest.
///
/// Shell-specific literal rules, matching each language's actual grammar:
/// - PowerShell `'...'`: no escapes at all; a doubled `''` is a literal quote and
///   does NOT end the string.
/// - PowerShell `"..."`: a backtick escapes the next character, so `` `" `` stays
///   inside the string.
/// - nu `'...'`: no escapes (this is why the nu wrapper can carry raw paths).
/// - nu `"..."`: backslash escapes, so `\"` stays inside the string.
///
/// Why not more (all out of scope, and all documented in the module header):
/// strings that span lines and here-strings (`@"..."@`, nu `r#'...'#`). Quote
/// state resets at every newline, so an unterminated quote blanks the rest of
/// THAT line only. That is the safe direction: the masked tail loses its braces,
/// so the block fails to close and the wrapper reads `stale`/`could not
/// determine` rather than `current`.
fn mask_line(line: &str, shell: ShellName, state: &mut MaskState) -> String {
    let is_pwsh = !matches!(shell, ShellName::Nushell);
    let mut out = String::with_capacity(line.len());
    let mut chars = line.char_indices().peekable();

    while let Some((_, c)) = chars.next() {
        // An open `<# ... #>` swallows everything until its terminator.
        if state.in_block_comment {
            let is_terminator = c == '#' && chars.peek().is_some_and(|(_, next)| *next == '>');
            if is_terminator {
                chars.next();
                push_spaces(&mut out, '>');
                state.in_block_comment = false;
            }
            push_spaces(&mut out, c);
            continue;
        }

        let opens_block_comment =
            is_pwsh && c == '<' && chars.peek().is_some_and(|(_, next)| *next == '#');
        if opens_block_comment {
            chars.next();
            push_spaces(&mut out, '#');
            push_spaces(&mut out, c);
            state.in_block_comment = true;
            continue;
        }

        let opens_string = c == '\'' || c == '"';
        if !opens_string {
            out.push(c);
            continue;
        }

        // Consume the literal, blanking it (delimiters included) so nothing
        // inside can be read as a brace, a flag or a comment marker.
        push_spaces(&mut out, c);
        let escape = string_escape_char(c, is_pwsh);
        while let Some((_, inner)) = chars.next() {
            let is_escape = escape == Some(inner);
            if is_escape {
                push_spaces(&mut out, inner);
                if let Some((_, escaped)) = chars.next() {
                    push_spaces(&mut out, escaped);
                }
                continue;
            }
            let is_closing = inner == c;
            if is_closing {
                // PowerShell/nu single quotes double `''` to embed one literal
                // quote, so a second quote right here reopens rather than closes.
                let is_doubled_quote =
                    c == '\'' && chars.peek().is_some_and(|(_, next)| *next == '\'');
                if is_doubled_quote {
                    chars.next();
                    push_spaces(&mut out, inner);
                    push_spaces(&mut out, inner);
                    continue;
                }
                push_spaces(&mut out, inner);
                break;
            }
            push_spaces(&mut out, inner);
        }
    }

    out
}

/// The escape character that keeps the next char inside a string, if any.
///
/// Only expandable (double-quoted) strings have one: PowerShell uses a backtick,
/// nu a backslash. Single-quoted literals in both languages have no escapes.
fn string_escape_char(quote: char, is_pwsh: bool) -> Option<char> {
    let is_expandable = quote == '"';
    if !is_expandable {
        return None;
    }
    Some(if is_pwsh { '`' } else { '\\' })
}

/// Append as many spaces as `c` occupies, so masking never shifts byte offsets.
fn push_spaces(out: &mut String, c: char) {
    for _ in 0..c.len_utf8() {
        out.push(' ');
    }
}

/// The outcome of scanning a wrapper definition's brace block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockScan {
    /// The block closed and requested its dialect: the current wrapper.
    ClosedWithMarker,
    /// The block closed with no dialect request: the pre-2.2.0 wrapper.
    ClosedWithoutMarker,
    /// The block ended at EOF or at the next wrapper definition without ever
    /// closing — no determinable extent, so nothing inside it can be trusted.
    NeverClosed,
    /// The scan hit [`MAX_BLOCK_SEARCH_LINES`] with the block still open.
    Exhausted,
}

/// Scan the brace block opened by the definition on `lines[0]`.
///
/// Every line is first run through [`mask_line`] (string contents and `<# #>`
/// block comments blanked) and then through [`strip_trailing_comment`]. That one
/// masked form drives BOTH the brace counting and the marker search, which is
/// what makes the two agree: a `}` inside `"..."` no longer closes the block, and
/// a `--eval-dialect` inside a string or a block comment no longer blesses it.
///
/// Restricting the marker search to the block's own character region is what
/// keeps a marker that lives OUTSIDE it — in a trailing comment, or in a statement
/// after the closing brace (`... } ; print '--eval-dialect nu'`) — from blessing a
/// stale wrapper: the marker is only accepted while brace depth is ≥ 1.
///
/// The in-block regions are accumulated into one buffer and tokenized ONCE, at
/// the end, rather than per line. A flag and its value may legitimately sit on
/// different lines — nu's `(\n ^vibe\n --eval-dialect\n nu\n ...$args\n)` is valid
/// syntax — and a per-line search would never see the pair, reporting a correct
/// wrapper as stale. Lines are joined with a space so no token is fused across
/// the line break.
///
/// The scan is bounded three ways: the matching close brace, the next wrapper
/// definition, and [`MAX_BLOCK_SEARCH_LINES`]. Without the last two, an
/// unbalanced brace (from a construct the masker does not model — see the module
/// header) would let the scan run to end of file and pick up an unrelated marker.
///
/// A marker is only honoured once the block is known to CLOSE. An unbalanced
/// block has no determinable extent, so a marker found inside the assumed region
/// could belong to unrelated code below; the wrapper is then reported stale,
/// which prints a fix for a possibly-correct wrapper — the safe direction, since
/// the alternative is silently blessing a broken one. Running out of scan budget
/// is reported separately ([`BlockScan::Exhausted`]) because there the classifier
/// has no evidence at all, not even the negative kind.
fn scan_block(lines: &[&str], shell: ShellName) -> BlockScan {
    let mut depth = 0usize;
    let mut opened = false;
    let mut region_buffer = String::new();
    let mut mask = MaskState::default();

    for (index, line) in lines.iter().take(MAX_BLOCK_SEARCH_LINES).enumerate() {
        // A whole-line comment still has to advance the block-comment state, so
        // mask it before skipping: a line that is only `<# ...` opens a comment
        // whose effect continues below.
        let masked = mask_line(line, shell, &mut mask);
        if is_comment(&masked) {
            continue;
        }
        // A following definition means this block never closed cleanly; stop
        // rather than absorb the next wrapper's marker.
        let is_following_definition = index > 0 && is_wrapper_definition(line, shell);
        if is_following_definition {
            return BlockScan::NeverClosed;
        }

        let code = strip_trailing_comment(&masked);
        let (region, closed) = block_region(code, &mut depth, &mut opened);
        region_buffer.push_str(region);
        region_buffer.push(' ');
        if closed {
            let seen_marker = region_contains_dialect_marker(&region_buffer, shell);
            return if seen_marker {
                BlockScan::ClosedWithMarker
            } else {
                BlockScan::ClosedWithoutMarker
            };
        }
    }

    let ran_out_of_budget = lines.len() > MAX_BLOCK_SEARCH_LINES;
    if ran_out_of_budget {
        return BlockScan::Exhausted;
    }
    BlockScan::NeverClosed
}

/// How far past the definition line the block scan may run.
///
/// Not a resource bound — [`MAX_PROFILE_SIZE`] already caps the whole input at
/// 1 MB, and that is the real guarantee that this scan terminates cheaply. What
/// this limit does is bound how much unrelated text an UNBALANCED brace can
/// absorb before a marker below it is wrongly credited to the wrapper. 1000 lines
/// is far past any hand-formatted wrapper (the documented multi-line nu form is 7
/// lines, Allman adds one) yet comfortably inside a real `config.nu`, so a user
/// with a long but legitimately braced wrapper is not pushed into
/// [`BlockScan::Exhausted`].
const MAX_BLOCK_SEARCH_LINES: usize = 1000;

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
const STATUS_INDETERMINATE: &str = "could not determine (wrapper block too long)";

/// The error shown when every profile root is unusable, per platform.
///
/// Why an error rather than an empty report: "no profile found" and "I could not
/// look anywhere" are different answers, and printing the former for the latter
/// tells the user their shell is clean when it was never inspected. The variable
/// NAMES appear so the user knows where to look; the values never do.
const NO_ROOT_UNIX: &str = "Cannot check shell profiles: HOME (or XDG_CONFIG_HOME) is unset or \
                            invalid. It must be an absolute path without '..' components.";
const NO_ROOT_WINDOWS: &str = "Cannot check shell profiles: APPDATA, USERPROFILE and OneDrive are \
                               all unset or invalid. One must be an absolute path without '..' \
                               components.";

/// Run `vibe doctor`.
pub fn doctor_command(
    io: &impl Io,
    fs: &impl ProfileFs,
    platform: HostPlatform,
    opts: OutputOptions,
) -> Result<Outcome> {
    let candidates = candidate_profiles(io, platform);

    // Absent profiles are omitted from the report (they are not findings), but
    // "doctor said nothing about my file" is exactly the confusing case, so
    // --verbose names every path that was actually looked at.
    for (_, path) in &candidates.profiles {
        verbose_log(
            io,
            &format!("checking {}", sanitize_for_display(&path.to_string_lossy())),
            opts,
        );
    }

    // No root at all means nothing was inspected. `Configuration` (not
    // `AlreadyReported`): no report has been printed yet, so the binary's
    // `Error:` line is the user's only explanation.
    let has_no_root = candidates.profiles.is_empty();
    if has_no_root {
        let message = if platform.is_windows {
            NO_ROOT_WINDOWS
        } else {
            NO_ROOT_UNIX
        };
        return Err(VibeError::Configuration(message.to_string()));
    }

    let findings: Vec<Finding> = candidates
        .profiles
        .into_iter()
        .filter_map(|(shell, path)| inspect(fs, shell, path))
        .collect();

    // `report_log`/`warn_log` (not `log`) so the report survives `--quiet`: a
    // stale finding exits 1, and exiting 1 in silence would be unexplainable.
    // Yellow is reserved for the findings themselves.
    report_log(io, "Checking shell wrappers for nushell and PowerShell...");

    // Right under the header, so a user whose profile is missing from the rows
    // below can see WHY it was never looked at. The variable name is a static
    // string and the value is never interpolated.
    for name in &candidates.skipped_roots {
        report_log(io, &format!("  {name}: skipped (invalid value)"));
    }

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
            // Not a finding: the classifier could not reach a verdict, so
            // failing the run would punish a file that may well be fine. The
            // row is printed and the closing shell-setup hint is the remedy.
            WrapperStatus::Indeterminate => (STATUS_INDETERMINATE, false, truncated),
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
