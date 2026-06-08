//! Thin binary-side command handlers.
//!
//! Each function builds the production side-effect implementations (`RealIo`,
//! `RealGit`, `RealRepoResolver`, `UreqClient`, `RealPrompt`) and delegates to
//! the corresponding `vibe_core::commands` handler, returning its [`Outcome`].
//! The single stdout write (the eval'd `cd` contract, with the newline guard)
//! lives in `main.rs`, not here.

use vibe_core::clock::{RealClock, RealRandom};
use vibe_core::commands::clean::{clean_command, CleanDeps, CleanFlags};
use vibe_core::commands::scratch::scratch_command;
use vibe_core::commands::start::{start_command, StartDeps, StartFlags};
use vibe_core::commands::{Outcome, RealProcessControl, RealStart};
use vibe_core::copy::{RealCopyExecutor, RealNativeClone, RealProbe};
use vibe_core::fast_remove::RealBackgroundSpawner;
use vibe_core::git::RealGit;
use vibe_core::hooks::RealHookRunner;
use vibe_core::http::UreqClient;
use vibe_core::io::{Io, RealIo};
use vibe_core::output::OutputOptions;
use vibe_core::progress::{IndicatifTracker, NullTracker, ProgressTracker};
use vibe_core::prompt::RealPrompt;
use vibe_core::repo_info::RealRepoResolver;
use vibe_core::stdin::RealStdinReader;
use vibe_core::worktree_path::RealScriptRunner;
use vibe_core::{commands, Result};

use crate::version;

/// `vibe config`.
pub fn config(opts: OutputOptions) -> Result<Outcome> {
    let _ = opts; // config ignores verbosity (matches the TS).
    let io = RealIo;
    let git = RealGit;
    let resolver = RealRepoResolver::new(&git);
    commands::config::config_command(&io, &resolver, version::VERSION)
}

/// `vibe verify`.
pub fn verify(opts: OutputOptions) -> Result<Outcome> {
    let io = RealIo;
    let git = RealGit;
    let resolver = RealRepoResolver::new(&git);
    commands::verify::verify_command(&io, &git, &resolver, version::VERSION, opts)
}

/// `vibe home`.
pub fn home(opts: OutputOptions) -> Result<Outcome> {
    let io = RealIo;
    let git = RealGit;
    commands::home::home_command(&io, &git, opts)
}

/// `vibe jump <branch_name>`.
///
/// Now wires the REAL start command into the no-match→create path (Phase 4):
/// `RealStart` runs `start_command` with all production seams.
pub fn jump(branch_name: &str, opts: OutputOptions) -> Result<Outcome> {
    let io = RealIo;
    let git = RealGit;
    let prompt = RealPrompt::new(&io);
    let start = RealStart {
        version: version::VERSION,
    };
    let deps = commands::jump::JumpDeps {
        io: &io,
        git: &git,
        prompt: &prompt,
        start: &start,
        now_ms: now_ms(),
    };
    commands::jump::jump_command(&deps, branch_name, opts)
}

/// `vibe trust`.
pub fn trust(opts: OutputOptions) -> Result<Outcome> {
    let io = RealIo;
    let git = RealGit;
    let resolver = RealRepoResolver::new(&git);
    commands::trust::trust_command(&io, &git, &resolver, version::VERSION, opts)
}

/// `vibe untrust`.
pub fn untrust(opts: OutputOptions) -> Result<Outcome> {
    let io = RealIo;
    let git = RealGit;
    let resolver = RealRepoResolver::new(&git);
    commands::untrust::untrust_command(&io, &git, &resolver, version::VERSION, opts)
}

/// `vibe rename <new_name> [--dry-run]`.
pub fn rename(new_name: &str, dry_run: bool, opts: OutputOptions) -> Result<Outcome> {
    let io = RealIo;
    let git = RealGit;
    let resolver = RealRepoResolver::new(&git);
    let script_runner = RealScriptRunner;
    let process = RealProcessControl;

    // realpath the cwd (resolve symlinks), falling back to the raw cwd — the TS
    // did `realPath(cwd)` with a try/catch fallback to the unresolved cwd.
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let real_cwd = std::fs::canonicalize(&cwd)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| cwd.clone());

    let deps = commands::rename::RenameDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        script_runner: &script_runner,
        process: &process,
        real_cwd: &real_cwd,
        version: version::VERSION,
        now_ms: now_ms(),
    };
    commands::rename::rename_command(&deps, new_name, dry_run, opts)
}

/// Choose a live progress tracker (interactive stderr, not quiet) or a no-op.
///
/// Both locals must outlive the borrow, so the caller owns them and passes a
/// `&dyn ProgressTracker + Sync` reference in.
fn pick_tracker<'a>(
    io: &impl Io,
    opts: OutputOptions,
    indicatif: &'a mut Option<IndicatifTracker>,
    null: &'a mut Option<NullTracker>,
) -> &'a (dyn ProgressTracker + Sync) {
    let live = io.is_stderr_terminal() && !opts.quiet;
    if live {
        *indicatif = Some(IndicatifTracker::new());
        indicatif.as_ref().unwrap()
    } else {
        *null = Some(NullTracker);
        null.as_ref().unwrap()
    }
}

/// Assemble `StartDeps` and run a `start`/`scratch` body. Keeps the seam wiring
/// in one place (both commands share the same StartDeps shape).
// The closure's `StartDeps<...>` parameter is necessarily verbose (it names all
// six generic seam types); a `type` alias cannot capture the higher-ranked `'a`.
#[allow(clippy::type_complexity)]
fn with_start_deps<T>(
    opts: OutputOptions,
    body: impl for<'a> FnOnce(
        &StartDeps<
            'a,
            RealIo,
            RealGit,
            RealRepoResolver<'a, RealGit>,
            RealScriptRunner,
            RealPrompt<'a, RealIo>,
            RealStdinReader<'a, RealIo>,
        >,
    ) -> Result<T>,
) -> Result<T> {
    let io = RealIo;
    let git = RealGit;
    let resolver = RealRepoResolver::new(&git);
    let script_runner = RealScriptRunner;
    let prompt = RealPrompt::new(&io);
    let stdin = RealStdinReader::new(&io);
    let hook_runner = RealHookRunner;
    let native = RealNativeClone;
    let probe = RealProbe;
    let executor = RealCopyExecutor::new(&native, &probe);

    let mut indicatif = None;
    let mut null = None;
    let tracker = pick_tracker(&io, opts, &mut indicatif, &mut null);

    let deps = StartDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        script_runner: &script_runner,
        prompt: &prompt,
        stdin: &stdin,
        hook_runner: &hook_runner,
        executor: &executor,
        tracker,
        version: version::VERSION,
    };
    body(&deps)
}

/// `vibe start <branch> [flags]`.
#[allow(clippy::too_many_arguments)]
pub fn start(
    branch_name: &str,
    force: bool,
    no_hooks: bool,
    no_copy: bool,
    dry_run: bool,
    base: Option<String>,
    track: bool,
    worktree_hook: bool,
    opts: OutputOptions,
) -> Result<Outcome> {
    // clap blocks `--base <flaglike>` (space form), so a leading-dash base value
    // can only have arrived via `--base=-x`; treat that as the "=" form so the
    // start guard allows it (TS parity for `baseFromEquals`).
    let base_from_equals = base.as_deref().map(|b| b.starts_with('-')).unwrap_or(false);
    let flags = StartFlags {
        no_hooks,
        no_copy,
        dry_run,
        base,
        base_from_equals,
        track,
        force,
        worktree_hook,
    };
    with_start_deps(opts, |deps| start_command(deps, branch_name, &flags, opts))
}

/// `vibe scratch [flags]`.
pub fn scratch(
    no_hooks: bool,
    no_copy: bool,
    dry_run: bool,
    base: Option<String>,
    track: bool,
    opts: OutputOptions,
) -> Result<Outcome> {
    let base_from_equals = base.as_deref().map(|b| b.starts_with('-')).unwrap_or(false);
    let flags = StartFlags {
        no_hooks,
        no_copy,
        dry_run,
        base,
        base_from_equals,
        track,
        force: false,
        worktree_hook: false,
    };
    let clock = RealClock;
    with_start_deps(opts, |deps| scratch_command(deps, &clock, &flags, opts))
}

/// `vibe clean [flags]`.
pub fn clean(
    force: bool,
    delete_branch: bool,
    keep_branch: bool,
    worktree_hook: bool,
    opts: OutputOptions,
) -> Result<Outcome> {
    let io = RealIo;
    let git = RealGit;
    let resolver = RealRepoResolver::new(&git);
    let prompt = RealPrompt::new(&io);
    let process = RealProcessControl;
    let stdin = RealStdinReader::new(&io);
    let hook_runner = RealHookRunner;
    let native = RealNativeClone;
    let spawner = RealBackgroundSpawner;
    let clock = RealClock;
    let random = RealRandom;

    let mut indicatif = None;
    let mut null = None;
    let tracker = pick_tracker(&io, opts, &mut indicatif, &mut null);

    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    let deps = CleanDeps {
        io: &io,
        git: &git,
        resolver: &resolver,
        prompt: &prompt,
        process: &process,
        stdin: &stdin,
        hook_runner: &hook_runner,
        native: &native,
        spawner: &spawner,
        tracker,
        clock: &clock,
        random: &random,
        cwd: &cwd,
        version: version::VERSION,
    };
    let flags = CleanFlags {
        force,
        delete_branch,
        keep_branch,
        worktree_hook,
    };
    clean_command(&deps, &flags, opts)
}

/// `vibe upgrade [--check]`.
pub fn upgrade(check: bool, opts: OutputOptions) -> Result<Outcome> {
    let io = RealIo;
    let http = UreqClient::new();

    let exec_path = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    // realpath: resolve symlinks; fall back to the exec path (TS does the same).
    let real_path = std::fs::canonicalize(&exec_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| exec_path.clone());

    let env = commands::upgrade::UpgradeEnv {
        version: version::VERSION,
        distribution: version::DISTRIBUTION,
        exec_path: &exec_path,
        real_path: &real_path,
        is_mac: std::env::consts::OS == "macos",
    };
    commands::upgrade::upgrade_command_run(&io, &http, &env, check, opts)
}

/// `vibe shell-setup [--shell <s>] [--with-completion]`.
pub fn shell_setup(
    shell: Option<&str>,
    with_completion: bool,
    opts: OutputOptions,
) -> Result<Outcome> {
    let io = RealIo;
    commands::shell_setup::shell_setup_command(&io, shell, with_completion, opts)
}

/// Current wall-clock in epoch milliseconds (injected into MRU recording).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
