//! `vibe start <branch>`: create or navigate to a worktree.
//!
//! Ported from `packages/core/src/commands/start.ts`. The validation cascade,
//! existing-branch navigate, same-branch idempotent re-entry, different-branch
//! Overwrite/Reuse/Cancel select, worktree creation, and the
//! submodule init → pre_start → copy → post_start config-and-hooks sequence
//! mirror the TS. The
//! Claude-Code `--claude-code-worktree-hook` mode reads a name from stdin and
//! outputs the worktree PATH to stdout (not a `cd`), with non-fatal post-setup.
//!
//! The single stdout write stays in the binary: a normal run returns
//! `Outcome::cd(path)`; the hook mode returns `Outcome::stdout(path)`. A hook
//! failure is non-fatal in NORMAL mode too, not just in hook mode, but its
//! effect on the `cd` depends on WHERE in the sequence it happened (issue #601),
//! mirroring `clean`'s `pre_clean`/`post_clean` split:
//!
//! - `pre_start` runs before the copy and is therefore a GATE. A failure warns
//!   and returns `Outcome::none()`: the copy and `post_start` are skipped, so
//!   the worktree is unprovisioned and the shell must stay where it is. This
//!   keeps a `pre_start` usable as a precondition check (secrets reachable,
//!   licence valid, …) that blocks entry.
//! - `post_start` runs after the worktree is fully provisioned, so a failure
//!   only warns and the `cd` is still returned — that is the actual #601 fix.
//!
//! The gate is DURABLE, which it only is because every path that hands back an
//! existing worktree re-runs the sequence first: creation, same-branch re-entry,
//! `--reuse`, and — the case that made it one-shot until the #601 review — the
//! "branch is already used in worktree X, navigate?" path. A gated run leaves
//! the worktree directory on disk, so the retry necessarily arrives through one
//! of those; if any of them cd'd without re-running the hooks, the precondition
//! would be enforced exactly once and bypassed forever after.
//!
//! Only `HookExecution` is downgraded — a failed copy or submodule step stays
//! fatal, so no `cd` into a half-built worktree is ever emitted.
//!
//! Hook mode has no shell to strand, so the gate cannot express itself as a
//! withheld `cd` there. It keeps emitting the path on stdout and exiting 0, and
//! reports the gated state on stderr as [`HOOK_MODE_GATED_SIGNAL`] instead
//! (issue #615).
//!
//! Seam strategy (architect's hybrid): the small, ubiquitous seams (`Io`,
//! `GitRunner`, `Prompt`, `RepoResolver`, `ScriptRunner`, `ProcessControl`) are
//! generic type params; the heavier copy/hook/progress/native seams are `&dyn`
//! to keep the generic surface from exploding.

use crate::commands::Outcome;
use crate::config::VibeConfig;
use crate::config_loader::{load_vibe_config, VIBE_TOML};
use crate::copy::strategies::CopyExecutor;
use crate::copy::symlink::{create_symlinks, SymlinkCreator};
use crate::copy_runner::{
    copy_directories, copy_files, copy_resolved_files, resolve_copy_concurrency,
};
use crate::error::{Result, VibeError};
use crate::git::{get_repo_name, get_repo_root, revision_exists, sanitize_branch_name, GitRunner};
use crate::git_copy::{collect_git_copy_files, resolve_selection, GitCopySelection};
use crate::glob::expand_copy_patterns;
use crate::hooks::{run_hooks, warn_on_hook_failure, HookEnv, HookRunner, HookTrackerInfo};
use crate::io::Io;
use crate::output::{
    error_log, log, log_dry_run, sanitize_for_display, verbose_log, warn_log, OutputOptions,
};
use crate::progress::ProgressTracker;
use crate::prompt::Prompt;
use crate::settings::RepoResolver;
use crate::settings_io::load_user_settings;
use crate::stdin::{read_worktree_hook_name, StdinReader};
use crate::worktree_ops::{
    create_worktree, get_create_worktree_command, remove_worktree, CreateWorktreeOptions,
};
use crate::worktree_path::{resolve_worktree_path, ScriptRunner, WorktreePathContext};
use crate::worktree_validator::{
    check_worktree_conflict, validate_branch_for_worktree, ConflictType,
};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

/// Flags controlling a `start` run (mirrors the TS `StartOptions`).
#[derive(Debug, Clone, Default)]
pub struct StartFlags {
    pub no_hooks: bool,
    pub no_copy: bool,
    /// `--copy-untracked`: force `[copy] untracked` on for this run.
    pub copy_untracked: bool,
    /// `--copy-modified`: force `[copy] modified` on for this run.
    pub copy_modified: bool,
    pub dry_run: bool,
    /// `--base <ref>` value (already trimmed by the caller is fine; we re-trim).
    pub base: Option<String>,
    /// Whether `--base` was given as `--base=<x>` (TS `baseFromEquals`): only then
    /// is a leading-dash base value allowed.
    pub base_from_equals: bool,
    pub track: bool,
    /// Skip confirmation prompts: navigate to an already-used branch, and
    /// overwrite a different-branch worktree at the target path.
    pub force: bool,
    /// On a different-branch conflict at the target path, auto-select Reuse (use
    /// the existing worktree) instead of prompting — the opposite of `force`,
    /// which auto-selects Overwrite. `force` and `reuse` are mutually exclusive
    /// (rejected at the dispatch layer).
    pub reuse: bool,
    /// Claude-Code WorktreeCreate hook mode (stdin name → stdout path).
    pub worktree_hook: bool,
}

/// Bundled seams for `start`.
pub struct StartDeps<'a, I, G, R, S, P, Sr>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    pub io: &'a I,
    pub git: &'a G,
    pub resolver: &'a R,
    pub script_runner: &'a S,
    pub prompt: &'a P,
    pub stdin: &'a Sr,
    pub hook_runner: &'a dyn HookRunner,
    // `+ Sync` so `copy_directories` can fan the executor/tracker across worker
    // threads (the live IndicatifTracker uses a Mutex; FakeCopyExecutor too).
    pub executor: &'a (dyn CopyExecutor + Sync),
    /// Creates the `[copy] symlink` shared-directory links. Not `Sync`-bound:
    /// symlink creation is a cheap metadata operation run sequentially, unlike
    /// the fanned-out directory copies.
    pub symlink_creator: &'a dyn SymlinkCreator,
    pub tracker: &'a (dyn ProgressTracker + Sync),
    pub version: &'a str,
}

/// Options bundle passed into the config-and-hooks helper.
struct ConfigAndHooks {
    skip_hooks: bool,
    skip_copy: bool,
    /// CLI `--copy-untracked` / `--copy-modified`, ORed with the config toggles.
    copy_untracked: bool,
    copy_modified: bool,
    dry_run: bool,
    /// Carried so the hook-failure summary can honour `--quiet`. `run_config_*`
    /// deliberately has no `OutputOptions` param of its own (TS parity: the inner
    /// copy/hook helpers own their progress output), so the one message that must
    /// respect the flag rides along in the options bundle instead.
    opts: OutputOptions,
}

/// Whether the config-and-hooks sequence left the worktree usable.
///
/// Only a `pre_start` failure yields `Gated`: it runs BEFORE the copy, so the
/// copy and `post_start` are skipped and the worktree is unprovisioned. A
/// `post_start` failure yields `Provisioned` — everything the worktree needs is
/// already in place (issue #601).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Provisioning {
    Provisioned,
    Gated,
}

impl Provisioning {
    /// Whether a caller holding a worktree path may return a `cd` into it.
    fn allows_cd(self) -> bool {
        self == Provisioning::Provisioned
    }
}

/// The stable, machine-readable stderr line `--claude-code-worktree-hook` emits
/// when a `pre_start` gate fired (issue #615).
///
/// Hook mode keeps its contract — the worktree path on stdout, exit 0 — because
/// a non-zero exit would make Claude Code treat an existing worktree as a failed
/// creation, which has the worse recovery story. The generic
/// `Warning: Hook "..." failed: ...` line already printed by
/// `warn_on_hook_failure` names the command, so it changes with the user's
/// config and is not something an agent can key on; this line is fixed and is
/// therefore the signal. It is emitted verbatim through the `Io` rather than via
/// [`warn_log`] on purpose: `warn_log` wraps the text in ANSI yellow when color
/// is enabled, which would break a byte-exact match.
pub const HOOK_MODE_GATED_SIGNAL: &str = "vibe: pre_start hook failed; worktree is not provisioned";

/// Run `vibe start <branch_name>`.
#[allow(clippy::too_many_arguments)]
pub fn start_command<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    branch_name: &str,
    flags: &StartFlags,
    opts: OutputOptions,
) -> Result<Outcome>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    if flags.worktree_hook {
        return start_worktree_hook_mode(deps, branch_name, flags, opts);
    }

    if branch_name.is_empty() {
        error_log(deps.io, "Error: Branch name is required");
        return Err(VibeError::AlreadyReported);
    }

    // --base value + leading-dash guard (TS logic). The 3-state result is matched
    // exhaustively so an invalid `--base` can never be silently dropped.
    let base_ref = match resolve_base_ref(deps, flags) {
        BaseRef::Present(b) => Some(b),
        BaseRef::Absent => None,
        BaseRef::Invalid => return Err(VibeError::AlreadyReported),
    };

    let repo_root = get_repo_root(deps.git)?;
    let repo_name = get_repo_name(deps.git)?;
    let sanitized = sanitize_branch_name(branch_name);

    verbose_log(deps.io, &format!("Repository root: {repo_root}"), opts);
    verbose_log(deps.io, &format!("Repository name: {repo_name}"), opts);
    verbose_log(deps.io, &format!("Sanitized branch: {sanitized}"), opts);

    let validation = validate_branch_for_worktree(deps.git, branch_name)?;

    // The branch is already checked out somewhere else. Resolved BEFORE the
    // config load below so the "cancelled"/dry-run answers cost nothing, but the
    // accepted answer is deliberately NOT returned here: re-entry has to go
    // through `run_config_and_hooks` like every other navigate path (see
    // `navigate_to_existing_branch_worktree`).
    let mut existing_branch_worktree = None;
    if !validation.is_valid {
        let Some(existing) = validation.existing_worktree_path.clone() else {
            return Err(VibeError::Worktree(
                "Branch is in use but worktree path is unknown".to_string(),
            ));
        };
        match handle_existing_branch_worktree(deps, branch_name, &existing, flags)? {
            ExistingBranchDecision::Done(outcome) => return Ok(outcome),
            ExistingBranchDecision::Navigate(path) => {
                // Standing in the worktree we would navigate to: there is no
                // entry to provision and nothing to gate, so return before the
                // config load below. Deferring this to
                // `navigate_to_existing_branch_worktree` (which repeats the
                // check for its other callers) would make an untrusted or
                // modified `.vibe.toml` fail a self-navigation that needs no
                // config at all — on develop this path returned the cd before
                // `load_vibe_config` ever ran, and that must stay true.
                if same_worktree(&repo_root, &path) {
                    return Ok(Outcome::cd(path));
                }
                existing_branch_worktree = Some(path);
            }
        }
    }

    if base_ref.is_some() && validation.branch_exists {
        warn_log(
            deps.io,
            &format!("Warning: Branch '{branch_name}' already exists; --base is ignored."),
        );
    }

    if let Some(base) = &base_ref {
        if !validation.branch_exists && !revision_exists(deps.git, base) {
            error_log(deps.io, &format!("Error: Base '{base}' not found"));
            return Err(VibeError::AlreadyReported);
        }
    }

    let settings = load_user_settings(deps.io, deps.resolver, deps.version)?;
    let config = load_vibe_config(deps.io, deps.resolver, deps.version, &repo_root)?;

    if let Some(existing) = existing_branch_worktree {
        return navigate_to_existing_branch_worktree(
            deps,
            config.as_ref(),
            &repo_root,
            &existing,
            flags,
            opts,
        );
    }

    let worktree_path = resolve_worktree_path(
        deps.io,
        deps.script_runner,
        config.as_ref(),
        &settings,
        &WorktreePathContext {
            repo_name,
            branch_name: branch_name.to_string(),
            sanitized_branch: sanitized,
            repo_root: repo_root.clone(),
        },
    )?;

    let conflict = check_worktree_conflict(deps.git, &worktree_path, branch_name)?;

    if conflict.conflict_type == ConflictType::SameBranch {
        return handle_same_branch_worktree(
            deps,
            config.as_ref(),
            &repo_root,
            &worktree_path,
            flags,
            opts,
        );
    }

    if conflict.has_conflict {
        let existing_branch = conflict.existing_branch.clone().unwrap_or_default();
        match handle_different_branch_conflict(
            deps,
            config.as_ref(),
            &repo_root,
            &worktree_path,
            &existing_branch,
            flags,
            opts,
        )? {
            ConflictDecision::Continue => {}
            ConflictDecision::Done(outcome) => return Ok(outcome),
        }
    }

    // Create the worktree.
    let create_opts = CreateWorktreeOptions {
        branch_name,
        worktree_path: &worktree_path,
        branch_exists: validation.branch_exists,
        base_ref: base_ref.as_deref().filter(|_| !validation.branch_exists),
        track: flags.track,
    };

    if flags.dry_run {
        log_dry_run(
            deps.io,
            &format!("Would run: {}", get_create_worktree_command(&create_opts)),
        );
        log_dry_run(deps.io, &format!("Worktree path: {worktree_path}"));
    } else {
        verbose_log(
            deps.io,
            &format!("Running: {}", get_create_worktree_command(&create_opts)),
            opts,
        );
        run_create_worktree_with_progress(deps, branch_name, &create_opts)?;
    }

    // The worktree now exists, so a failing `post_start` must not suppress the
    // `cd` (issue #601); a failing `pre_start` gates it, and non-hook failures
    // still propagate and stay fatal.
    let provisioning = run_config_and_hooks(
        deps,
        config.as_ref(),
        &repo_root,
        &worktree_path,
        &ConfigAndHooks {
            skip_hooks: flags.no_hooks,
            skip_copy: flags.no_copy,
            copy_untracked: flags.copy_untracked,
            copy_modified: flags.copy_modified,
            dry_run: flags.dry_run,
            opts,
        },
    )?;
    if !provisioning.allows_cd() {
        // The worktree stays created (as it did before #601) — only the cd is
        // withheld, so the user lands back in the repo they started from and
        // can act on the warning. Re-running after the fix reaches the same
        // sequence via `navigate_to_existing_branch_worktree` (the branch is now
        // checked out here), so the gate is re-evaluated and the copy and
        // `post_start` finally run.
        return Ok(Outcome::none());
    }

    if flags.dry_run {
        log_dry_run(
            deps.io,
            &format!("Would change directory to: {worktree_path}"),
        );
        return Ok(Outcome::none());
    }

    Ok(Outcome::cd(worktree_path))
}

fn run_create_worktree_with_progress<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    branch_name: &str,
    create_opts: &CreateWorktreeOptions<'_>,
) -> Result<()>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    deps.tracker.start();
    let phase = deps
        .tracker
        .add_phase(&format!("Setting up worktree {branch_name}"));
    let task = deps.tracker.add_task(phase, "Create worktree");
    deps.tracker.start_task(task);

    match create_worktree(deps.git, create_opts) {
        Ok(()) => {}
        Err(err) => {
            deps.tracker.fail_task(task, &err.to_string());
            deps.tracker.finish();
            return Err(err);
        }
    }

    deps.tracker.complete_task(task);
    deps.tracker.finish();
    Ok(())
}

/// Outcome of resolving the `--base` flag, self-describing so the caller cannot
/// confuse "not given" with "given but invalid".
enum BaseRef {
    /// `--base <ref>` was given and is valid.
    Present(String),
    /// `--base` was not given at all (clean case).
    Absent,
    /// `--base` was given but invalid; the error was ALREADY reported via
    /// `error_log`, so the caller must return [`VibeError::AlreadyReported`].
    Invalid,
}

/// Resolve the `--base` value, applying the empty + leading-dash guards.
///
/// The 3-state [`BaseRef`] makes the two "no usable base" cases distinct: a
/// caller can never accidentally treat an [`BaseRef::Invalid`] (error already
/// printed) as a clean [`BaseRef::Absent`].
fn resolve_base_ref<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    flags: &StartFlags,
) -> BaseRef
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    let Some(raw) = &flags.base else {
        return BaseRef::Absent;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        error_log(deps.io, "Error: --base requires a value");
        return BaseRef::Invalid;
    }
    if trimmed.starts_with('-') && !flags.base_from_equals {
        error_log(deps.io, "Error: --base requires a value");
        return BaseRef::Invalid;
    }
    BaseRef::Present(trimmed.to_string())
}

/// What the caller should do about a branch already checked out elsewhere.
///
/// Split from the `Outcome` on purpose: the accepted answer is a *request* to
/// navigate, not a finished result. Returning `Outcome::cd` straight from here
/// is what made the `pre_start` gate one-shot (issue #601 review) — the second
/// `vibe start` for the same branch matched this path and cd'd in without ever
/// re-running the hook that had gated the first one.
enum ExistingBranchDecision {
    /// Fully handled (dry-run, or the user declined): return this outcome as-is.
    Done(Outcome),
    /// The user wants the existing worktree at this path; the caller must still
    /// run the config-and-hooks sequence against it before emitting a `cd`.
    Navigate(String),
}

/// Handle a branch already used by another worktree: decide whether to navigate.
fn handle_existing_branch_worktree<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    branch_name: &str,
    existing: &str,
    flags: &StartFlags,
) -> Result<ExistingBranchDecision>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    if flags.dry_run {
        log_dry_run(
            deps.io,
            &format!("Branch '{branch_name}' is already used in worktree '{existing}'"),
        );
        log_dry_run(deps.io, &format!("Would navigate to: {existing}"));
        return Ok(ExistingBranchDecision::Done(Outcome::none()));
    }

    if flags.force {
        return Ok(ExistingBranchDecision::Navigate(existing.to_string()));
    }

    let navigate = deps.prompt.confirm(&format!(
        "Branch '{branch_name}' is already used in worktree '{existing}'.\nNavigate to the existing worktree? (Y/n)"
    ));
    if navigate {
        Ok(ExistingBranchDecision::Navigate(existing.to_string()))
    } else {
        log(deps.io, "Cancelled", OutputOptions::new(false, false));
        Ok(ExistingBranchDecision::Done(Outcome::none()))
    }
}

/// Re-entry into the worktree a branch is already checked out in: run the
/// config-and-hooks sequence against it, then cd (or gate).
///
/// Why the hooks run again on a pure navigate: a `pre_start` is a PRECONDITION,
/// and a precondition that is only checked on the run that happens to create the
/// worktree is not a precondition at all. Before this, a gated first run left the
/// worktree on disk, so every retry took this path and walked straight in with
/// the gate never re-evaluated. Re-running also re-does the copy and
/// `post_start`, which is what makes "fix the cause and re-run `vibe start`"
/// actually provision the worktree — the same semantics
/// `handle_same_branch_worktree` and `reuse_existing_worktree` already have.
///
/// `existing` is never the caller's own worktree: `start_command` returns the
/// self-navigation cd before the config load, so this function only ever
/// provisions a DIFFERENT worktree (see the `same_worktree` guard there).
fn navigate_to_existing_branch_worktree<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    config: Option<&VibeConfig>,
    repo_root: &str,
    existing: &str,
    flags: &StartFlags,
    opts: OutputOptions,
) -> Result<Outcome>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    let provisioning = run_config_and_hooks(
        deps,
        config,
        repo_root,
        existing,
        &ConfigAndHooks {
            skip_hooks: flags.no_hooks,
            skip_copy: flags.no_copy,
            copy_untracked: flags.copy_untracked,
            copy_modified: flags.copy_modified,
            dry_run: false,
            opts,
        },
    )?;
    if !provisioning.allows_cd() {
        return Ok(Outcome::none());
    }
    Ok(Outcome::cd(existing.to_string()))
}

/// Same-branch worktree: idempotent re-entry (run hooks/config, then cd).
fn handle_same_branch_worktree<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    config: Option<&VibeConfig>,
    repo_root: &str,
    worktree_path: &str,
    flags: &StartFlags,
    opts: OutputOptions,
) -> Result<Outcome>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    if flags.dry_run {
        log_dry_run(
            deps.io,
            &format!("Worktree already exists at '{worktree_path}'"),
        );
        log_dry_run(
            deps.io,
            "Would run hooks and config, then navigate to worktree",
        );
        // The `Provisioning` verdict is ignored on purpose: dry-run never
        // reaches `run_hooks` (every lifecycle step short-circuits to
        // `log_dry_run`), so no hook can gate here, and the outcome below is
        // `Outcome::none()` either way.
        run_config_and_hooks(
            deps,
            config,
            repo_root,
            worktree_path,
            &ConfigAndHooks {
                skip_hooks: flags.no_hooks,
                skip_copy: flags.no_copy,
                copy_untracked: flags.copy_untracked,
                copy_modified: flags.copy_modified,
                dry_run: true,
                opts,
            },
        )?;
        log_dry_run(
            deps.io,
            &format!("Would change directory to: {worktree_path}"),
        );
        return Ok(Outcome::none());
    }

    log(
        deps.io,
        &format!("Note: Worktree already exists at '{worktree_path}'"),
        opts,
    );
    // Re-entry into an existing worktree: a failing `post_start` warns but still
    // cds, a failing `pre_start` gates the cd (issue #601).
    //
    // No regression test guards this specific branch: the same-branch case is
    // currently unreachable through `start_command` because
    // `validate_branch_for_worktree` matches before `check_worktree_conflict`
    // (see `start_tests.rs::same_branch_at_target_is_idempotent_cd`). The
    // `--reuse`/interactive-reuse sibling below IS covered. If that precedence
    // ever changes, wire a case here.
    let provisioning = run_config_and_hooks(
        deps,
        config,
        repo_root,
        worktree_path,
        &ConfigAndHooks {
            skip_hooks: flags.no_hooks,
            skip_copy: flags.no_copy,
            copy_untracked: flags.copy_untracked,
            copy_modified: flags.copy_modified,
            dry_run: false,
            opts,
        },
    )?;
    if !provisioning.allows_cd() {
        return Ok(Outcome::none());
    }
    Ok(Outcome::cd(worktree_path.to_string()))
}

/// Outcome of the different-branch conflict resolution.
enum ConflictDecision {
    /// Proceed to create the worktree (Overwrite chosen).
    Continue,
    /// Fully handled (Reuse → cd, Cancel → no-op, dry-run → no-op).
    Done(Outcome),
}

/// Different-branch conflict: prompt Overwrite/Reuse/Cancel.
fn handle_different_branch_conflict<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    config: Option<&VibeConfig>,
    repo_root: &str,
    worktree_path: &str,
    existing_branch: &str,
    flags: &StartFlags,
    opts: OutputOptions,
) -> Result<ConflictDecision>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    if flags.dry_run {
        log_dry_run(
            deps.io,
            &format!("Directory '{worktree_path}' already exists (branch: {existing_branch})"),
        );
        log_dry_run(deps.io, "Would prompt to Overwrite/Reuse/Cancel");
        return Ok(ConflictDecision::Done(Outcome::none()));
    }

    if flags.force {
        remove_worktree(deps.git, worktree_path, true)?;
        return Ok(ConflictDecision::Continue);
    }

    if flags.reuse {
        // --reuse auto-selects the Reuse choice (the --force opposite): no prompt.
        return reuse_existing_worktree(deps, config, repo_root, worktree_path, flags, opts);
    }

    let choice = deps.prompt.select(
        &format!("Directory '{worktree_path}' already exists (branch: {existing_branch}):"),
        &[
            "Overwrite (remove and recreate)".to_string(),
            "Reuse (use existing)".to_string(),
            "Cancel".to_string(),
        ],
    )?;

    match choice {
        0 => {
            // Overwrite: remove the existing worktree, then continue to create.
            remove_worktree(deps.git, worktree_path, true)?;
            Ok(ConflictDecision::Continue)
        }
        1 => reuse_existing_worktree(deps, config, repo_root, worktree_path, flags, opts),
        _ => {
            // Cancel.
            log(deps.io, "Cancelled", OutputOptions::new(false, false));
            Ok(ConflictDecision::Done(Outcome::none()))
        }
    }
}

/// Reuse the existing worktree at a conflicting path: skip creation, run
/// hooks/config, then cd. Shared by the interactive "Reuse" choice and `--reuse`.
fn reuse_existing_worktree<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    config: Option<&VibeConfig>,
    repo_root: &str,
    worktree_path: &str,
    flags: &StartFlags,
    opts: OutputOptions,
) -> Result<ConflictDecision>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    // The reused worktree exists, so a failing `post_start` warns but still cds;
    // a failing `pre_start` gates the cd, since the reuse never got past its
    // precondition (issue #601).
    let provisioning = run_config_and_hooks(
        deps,
        config,
        repo_root,
        worktree_path,
        &ConfigAndHooks {
            skip_hooks: flags.no_hooks,
            skip_copy: flags.no_copy,
            copy_untracked: flags.copy_untracked,
            copy_modified: flags.copy_modified,
            dry_run: false,
            opts,
        },
    )?;
    if !provisioning.allows_cd() {
        return Ok(ConflictDecision::Done(Outcome::none()));
    }
    Ok(ConflictDecision::Done(Outcome::cd(
        worktree_path.to_string(),
    )))
}

/// Run config-driven operations: listed submodule configs → pre_start (in
/// repo_root) → copy files + dirs → post_start (in worktree_path).
fn run_config_and_hooks<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    config: Option<&VibeConfig>,
    repo_root: &str,
    worktree_path: &str,
    options: &ConfigAndHooks,
) -> Result<Provisioning>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    // No `OutputOptions` param: the TS `runConfigAndHooks` does not verbose-log
    // (its inner copy/hook helpers own their own progress output via the tracker).
    //
    // `--copy-untracked` / `--copy-modified` are meaningful in a repo with NO
    // `.vibe.toml` — carrying work in progress into a new worktree is exactly the
    // ad-hoc case where nobody has written a config yet. So an absent config
    // short-circuits only when neither flag asks for git-derived files; otherwise
    // an empty config stands in and the normal copy path runs.
    let empty_config;
    let config = match config {
        Some(config) => config,
        None if options.skip_copy || !(options.copy_untracked || options.copy_modified) => {
            return Ok(Provisioning::Provisioned)
        }
        None => {
            empty_config = VibeConfig::default();
            &empty_config
        }
    };

    // Resolved here, but NOT enumerated here: `git ls-files` runs inside
    // `run_config_body`, after `pre_start`, so a file a hook creates or edits in
    // the origin repo is carried over. `config_has_operations` therefore only
    // gets the boolean "a git source is enabled" — a pre-enumeration signal — so
    // the tracker still starts for a run whose only work is the git-derived copy,
    // without moving the `ls-files` call back ahead of the hooks.
    //
    // Only the top-level repo is enumerated: `deps.git` runs in the process cwd,
    // so a submodule's own `[copy] untracked` would list the parent repo's files,
    // not the submodule's.
    let git_selection = if options.skip_copy {
        GitCopySelection::default()
    } else {
        resolve_selection(Some(config), options.copy_untracked, options.copy_modified)
    };

    let has_ops = !options.dry_run && config_has_operations(config, options, git_selection);
    if has_ops {
        deps.tracker.start();
    }

    let result = run_submodule_configs(deps, config, repo_root, worktree_path, options).and_then(
        |submodules| {
            if submodules == Provisioning::Gated {
                return Ok(Provisioning::Gated);
            }
            run_config_body(
                deps,
                config,
                repo_root,
                worktree_path,
                repo_root,
                git_selection,
                options,
            )
        },
    );

    // Finished on every non-fatal end, gated included: those return to the user
    // with the run over, and an unfinished tracker would leave a live progress
    // display in front of the prompt. Safe on the gated path because `run_hooks`
    // closes the commands it skipped as SKIPPED before returning, so `finish`
    // has no never-run bar left to stamp with the success glyph.
    //
    // Why not on every error: `IndicatifTracker::finish` closes each still-open
    // bar with the SUCCESS glyph and no annotation, so finishing after a fatal
    // copy/submodule failure would render its pending COPY tasks as completed
    // right above the `Error:` line. Those bars are deliberately left abandoned
    // until issue #600 adds a distinct abort glyph.
    if has_ops && result.is_ok() {
        deps.tracker.finish();
    }

    result
}

/// Run hooks/copy for one already-loaded config. Submodule configs use this
/// helper directly so their own `[submodules]` section is intentionally not
/// followed recursively.
#[allow(clippy::too_many_arguments)]
fn run_config_body<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    config: &VibeConfig,
    repo_root: &str,
    worktree_path: &str,
    copy_source_root: &str,
    // Which git-derived sources to enumerate once `pre_start` has run. Empty for
    // submodule bodies (see `run_config_and_hooks`).
    git_selection: GitCopySelection,
    options: &ConfigAndHooks,
) -> Result<Provisioning>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    // pre_start hooks (in repo_root). A failure is a GATE: warn, then stop
    // before the copy so the caller emits no cd (issue #601).
    //
    // Why not warn-and-continue like `post_start`: `pre_start` is the only
    // lifecycle point a user can express a precondition at, and the copy and
    // `post_start` below are skipped anyway, so continuing would hand back a
    // worktree the config never finished setting up.
    if !options.skip_hooks
        && !warn_on_hook_failure(
            deps.io,
            run_lifecycle_hooks(
                deps,
                config.hooks.as_ref().and_then(|h| h.pre_start.as_deref()),
                "Pre-start hooks",
                "pre-start",
                repo_root,
                worktree_path,
                repo_root,
                options.dry_run,
            ),
            options.opts,
        )?
    {
        return Ok(Provisioning::Gated);
    }

    // Enumerate the git-derived sources HERE — after `pre_start`, immediately
    // before the copy — so the documented `pre_start` → copy → `post_start`
    // ordering holds for them too: a hook that writes a scratch file or edits a
    // tracked one in the origin repo must have that file carried over, and an
    // enumeration taken before the hooks ran could not see it.
    let git_copy_files =
        collect_git_copy_files(deps.io, deps.git, copy_source_root, git_selection)?;

    // symlink shared directories, then copy files + directories.
    if !options.skip_copy {
        let symlinks = config
            .copy
            .as_ref()
            .and_then(|c| c.symlink.as_deref())
            .unwrap_or(&[]);

        // Symlinks first: a shared directory must exist before a post_start hook
        // or a later copy could observe a half-set-up worktree.
        //
        // The return value is the set of entries a link actually EXISTS for, not
        // the raw config: a pattern rejected as a glob (or invalid, or missing
        // in the origin) creates nothing, so it must not suppress a legitimate
        // `files`/`dirs` copy of the same path.
        let symlinked = create_symlinks(
            deps.io,
            &deps.symlink_creator,
            deps.tracker,
            symlinks,
            copy_source_root,
            worktree_path,
            options.dry_run,
        );

        // A created `symlink` entry WINS over a `files`/`dirs` pattern covering
        // the same path, and equally over a git-derived candidate: the point of
        // sharing is to not duplicate it. The runners apply the exclusion AFTER
        // expansion, so `dirs = [".*"]` cannot sneak a copy over (and through) a
        // `symlink = [".cache"]` link, and neither can an untracked file that
        // `git status` reports beneath one.
        let patterns = config
            .copy
            .as_ref()
            .and_then(|c| c.files.as_deref())
            .unwrap_or(&[]);

        if git_copy_files.is_empty() {
            copy_files(
                deps.io,
                &deps.executor,
                deps.tracker,
                patterns,
                &symlinked,
                copy_source_root,
                worktree_path,
                options.dry_run,
            );
        } else {
            // Configured patterns are expanded here (not inside `copy_files`) so
            // the git-derived paths can join the SAME list: they are literal
            // filenames, and a name containing `[`/`{`/`*`/`?` would be misread as
            // a glob by the expander. One combined list also means one progress
            // phase and one dedup pass across both sources.
            let mut files = expand_copy_patterns(deps.io, patterns, copy_source_root);
            let mut seen: HashSet<String> = files.iter().cloned().collect();
            for file in git_copy_files {
                if seen.insert(file.clone()) {
                    files.push(file);
                }
            }
            copy_resolved_files(
                deps.io,
                &deps.executor,
                deps.tracker,
                &files,
                &symlinked,
                copy_source_root,
                worktree_path,
                options.dry_run,
            );
        }

        let dirs = config
            .copy
            .as_ref()
            .and_then(|c| c.dirs.as_deref())
            .unwrap_or(&[]);
        if !dirs.is_empty() {
            let concurrency = resolve_copy_concurrency(deps.io, Some(config));
            // The injected `&dyn CopyExecutor` / `&dyn ProgressTracker` are
            // Send+Sync at the trait-object level; copy_directories needs Sync.
            let res = copy_directories(
                deps.io,
                &deps.executor,
                &deps.tracker,
                dirs,
                &symlinked,
                copy_source_root,
                worktree_path,
                options.dry_run,
                concurrency,
            );
            if let Err(e) = res {
                // A directory-copy error aborts the op (matches Promise.all reject
                // bubbling out of runConfigAndHooks in the TS).
                return Err(VibeError::FileSystem(e));
            }
        }
    }

    // post_start hooks (in worktree_path). The worktree is fully provisioned by
    // now, so a failure only warns and the caller still cds (issue #601).
    if !options.skip_hooks {
        warn_on_hook_failure(
            deps.io,
            run_lifecycle_hooks(
                deps,
                config.hooks.as_ref().and_then(|h| h.post_start.as_deref()),
                "Post-start hooks",
                "post-start",
                worktree_path,
                worktree_path,
                repo_root,
                options.dry_run,
            ),
            options.opts,
        )?;
    }

    Ok(Provisioning::Provisioned)
}

/// Whether config has any hook/copy operation (drives starting the tracker).
///
/// `git_selection` counts as one pending operation when either source is on, so
/// a run whose only work is copying untracked/modified files still gets a
/// progress UI. It is deliberately the *selection*, not an enumerated count:
/// enumeration happens after `pre_start` (see `run_config_body`), which is later
/// than this decision.
fn config_has_operations(
    config: &VibeConfig,
    options: &ConfigAndHooks,
    git_selection: GitCopySelection,
) -> bool {
    let has_submodule_configs =
        submodule_config_paths(config).is_some_and(|paths| !paths.is_empty());
    let hooks_count = if options.skip_hooks {
        0
    } else {
        config
            .hooks
            .as_ref()
            .map(|h| {
                h.pre_start.as_ref().map(|v| v.len()).unwrap_or(0)
                    + h.post_start.as_ref().map(|v| v.len()).unwrap_or(0)
            })
            .unwrap_or(0)
    };
    let copy_count = if options.skip_copy {
        0
    } else {
        config
            .copy
            .as_ref()
            .map(|c| {
                c.files.as_ref().map(|v| v.len()).unwrap_or(0)
                    + c.dirs.as_ref().map(|v| v.len()).unwrap_or(0)
                    + c.symlink.as_ref().map(|v| v.len()).unwrap_or(0)
            })
            .unwrap_or(0)
            + usize::from(!git_selection.is_empty())
    };
    has_submodule_configs || hooks_count + copy_count > 0
}

fn submodule_config_paths(config: &VibeConfig) -> Option<&[String]> {
    config
        .submodules
        .as_ref()
        .and_then(|s| s.configs.as_deref())
}

fn run_submodule_configs<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    config: &VibeConfig,
    repo_root: &str,
    worktree_path: &str,
    options: &ConfigAndHooks,
) -> Result<Provisioning>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    let Some(paths) = submodule_config_paths(config).filter(|paths| !paths.is_empty()) else {
        return Ok(Provisioning::Provisioned);
    };

    let paths = validate_submodule_config_paths(deps, repo_root, paths)?;
    init_submodules(deps, worktree_path, &paths, options.dry_run)?;

    for path in &paths {
        let roots = resolve_submodule_roots(repo_root, worktree_path, path, options.dry_run)?;
        let config_root = if options.dry_run {
            &roots.origin
        } else {
            &roots.worktree
        };
        let Some(submodule_config) =
            load_vibe_config(deps.io, deps.resolver, deps.version, config_root)?
        else {
            return Err(VibeError::Configuration(format!(
                "Submodule '{path}' is listed in [submodules] configs, but {}/{} does not exist",
                config_root, VIBE_TOML
            )));
        };

        // A submodule's own `pre_start` gate stops the whole run: its copy and
        // `post_start` were skipped, so the parent worktree is no more usable
        // than if the parent's own gate had failed.
        if run_config_body(
            deps,
            &submodule_config,
            config_root,
            &roots.worktree,
            &roots.origin,
            // No git-derived files for a submodule: `deps.git` runs in the
            // process cwd (the superproject), so `ls-files` there would enumerate
            // the parent repo, not this submodule.
            GitCopySelection::default(),
            options,
        )? == Provisioning::Gated
        {
            return Ok(Provisioning::Gated);
        }
    }

    Ok(Provisioning::Provisioned)
}

fn init_submodules<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    worktree_path: &str,
    paths: &[String],
    dry_run: bool,
) -> Result<()>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    let joined_paths = paths.join(" ");
    let command = format!("git -C {worktree_path} submodule update --init -- {joined_paths}");

    if dry_run {
        log_dry_run(deps.io, &format!("Would run: {command}"));
        return Ok(());
    }

    let phase = deps.tracker.add_phase("Initializing submodules");
    let task = deps.tracker.add_task(
        phase,
        &format!("git submodule update --init -- {joined_paths}"),
    );
    deps.tracker.start_task(task);
    let mut args = vec!["-C", worktree_path, "submodule", "update", "--init", "--"];
    args.extend(paths.iter().map(String::as_str));
    let result = deps.git.run(&args);

    match result {
        Ok(_) => {
            deps.tracker.complete_task(task);
            Ok(())
        }
        Err(err) => {
            deps.tracker.fail_task(task, &err.to_string());
            Err(err)
        }
    }
}

fn validate_submodule_config_paths<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    repo_root: &str,
    paths: &[String],
) -> Result<Vec<String>>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    let mut seen = HashSet::new();
    let mut validated = Vec::new();

    for path in paths {
        validate_submodule_config_path(path)?;
    }

    let direct_submodules = direct_submodule_paths(deps, repo_root)?;
    for path in paths {
        let is_direct_submodule = direct_submodules.contains(path);
        if !is_direct_submodule {
            return Err(VibeError::Configuration(format!(
                "[submodules] configs entry '{path}' must exactly match a direct path in .gitmodules"
            )));
        }
        let is_new = seen.insert(path.clone());
        if is_new {
            validated.push(path.clone());
        }
    }

    Ok(validated)
}

fn validate_submodule_config_path(path: &str) -> Result<()> {
    let has_surrounding_whitespace = path.trim() != path;
    if path.is_empty() || has_surrounding_whitespace {
        return Err(invalid_submodule_config_path(path));
    }
    let has_control_chars = path.chars().any(char::is_control);
    let has_glob_chars = path
        .chars()
        .any(|c| matches!(c, '*' | '?' | '[' | ']' | '{' | '}'));
    if has_control_chars || has_glob_chars {
        return Err(invalid_submodule_config_path(path));
    }

    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(invalid_submodule_config_path(path));
    }

    let mut has_component = false;
    for component in candidate.components() {
        match component {
            Component::Normal(_) => has_component = true,
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err(invalid_submodule_config_path(path));
            }
        }
    }

    if !has_component {
        return Err(invalid_submodule_config_path(path));
    }

    Ok(())
}

fn invalid_submodule_config_path(path: &str) -> VibeError {
    VibeError::Configuration(format!(
        "[submodules] configs entry '{path}' must be a parent-repo-relative submodule path without absolute paths, traversal, glob characters, or control characters"
    ))
}

fn direct_submodule_paths<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    repo_root: &str,
) -> Result<HashSet<String>>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    let gitmodules = Path::new(repo_root).join(".gitmodules");
    if !gitmodules.exists() {
        return Err(VibeError::Configuration(
            "[submodules] configs requires a .gitmodules file".to_string(),
        ));
    }

    let output = deps.git.run(&[
        "-C",
        repo_root,
        "config",
        "--file",
        ".gitmodules",
        "--get-regexp",
        r"^submodule\..*\.path$",
    ])?;

    let mut paths = HashSet::new();
    for line in output.lines() {
        let Some((_, path)) = line.split_once(' ') else {
            continue;
        };
        paths.insert(path.trim().to_string());
    }
    Ok(paths)
}

struct SubmoduleRoots {
    origin: String,
    worktree: String,
}

fn resolve_submodule_roots(
    repo_root: &str,
    worktree_path: &str,
    submodule_path: &str,
    dry_run: bool,
) -> Result<SubmoduleRoots> {
    let origin_parent = canonicalize_existing(Path::new(repo_root), "repository root")?;
    let origin = canonicalize_existing(
        &PathBuf::from(repo_root).join(submodule_path),
        "origin submodule",
    )?;
    ensure_child_path(&origin_parent, &origin, submodule_path, "origin submodule")?;

    let worktree = if dry_run {
        PathBuf::from(worktree_path).join(submodule_path)
    } else {
        let worktree_parent = canonicalize_existing(Path::new(worktree_path), "worktree root")?;
        let worktree = canonicalize_existing(
            &PathBuf::from(worktree_path).join(submodule_path),
            "worktree submodule",
        )?;
        ensure_child_path(
            &worktree_parent,
            &worktree,
            submodule_path,
            "worktree submodule",
        )?;
        worktree
    };

    Ok(SubmoduleRoots {
        origin: origin.to_string_lossy().into_owned(),
        worktree: worktree.to_string_lossy().into_owned(),
    })
}

/// Whether two paths name the same worktree directory.
///
/// Why the canonicalization is best-effort rather than `?`: this only decides
/// whether to SKIP redundant work, so a path that cannot be resolved (removed
/// under us, permission denied) must fall back to the raw string compare and let
/// the normal provisioning path report the real error, not turn a comparison
/// into a fatal one of its own.
fn same_worktree(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (Path::new(a).canonicalize(), Path::new(b).canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn canonicalize_existing(path: &Path, label: &str) -> Result<PathBuf> {
    path.canonicalize().map_err(|e| {
        VibeError::Configuration(format!(
            "Failed to resolve {label} path '{}': {e}",
            path.display()
        ))
    })
}

fn ensure_child_path(parent: &Path, child: &Path, submodule_path: &str, label: &str) -> Result<()> {
    if child.starts_with(parent) {
        return Ok(());
    }

    Err(VibeError::Configuration(format!(
        "Resolved {label} path for '{submodule_path}' escapes its parent repository"
    )))
}

/// Run a lifecycle hook list with a phase/tasks on the tracker.
///
/// DELIBERATE asymmetry vs `clean`'s `run_lifecycle_hooks`: here the tracker's
/// `start()`/`finish()` lifecycle is owned by the OUTER `run_config_and_hooks`
/// (which brackets pre/copy/post together), so this helper only adds the phase
/// and tasks. In `clean`, the helper manages `start()`/`finish()` itself. Do
/// not "unify" the two.
#[allow(clippy::too_many_arguments)]
fn run_lifecycle_hooks<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    hooks: Option<&[String]>,
    phase_label: &str,
    dry_label: &str,
    cwd: &str,
    worktree_path: &str,
    origin_path: &str,
    dry_run: bool,
) -> Result<()>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    let Some(hooks) = hooks.filter(|h| !h.is_empty()) else {
        return Ok(());
    };

    if dry_run {
        log_dry_run(deps.io, &format!("Would run {dry_label} hooks:"));
        for hook in hooks {
            // Sanitized for the same reason the failure summary is: the command
            // is verbatim `.vibe.toml` content, trusted by content HASH rather
            // than by judgement, so an ESC or bidi override in it would rewrite
            // the terminal around the dry-run report.
            log_dry_run(deps.io, &format!("  - {}", sanitize_for_display(hook)));
        }
        return Ok(());
    }

    let phase = deps.tracker.add_phase(phase_label);
    // Only the progress LABEL is sanitized — `hooks` is passed to `run_hooks`
    // untouched below, so the command still EXECUTES verbatim.
    let task_ids: Vec<_> = hooks
        .iter()
        .map(|h| deps.tracker.add_task(phase, &sanitize_for_display(h)))
        .collect();
    let info = HookTrackerInfo {
        tracker: deps.tracker,
        task_ids: &task_ids,
    };
    run_hooks(
        deps.io,
        &deps.hook_runner,
        hooks,
        cwd,
        &HookEnv {
            worktree_path,
            origin_path,
        },
        Some(&info),
    )
}

/// Claude-Code WorktreeCreate hook mode: name from stdin (or CLI arg), stdout the
/// worktree PATH (not a cd). Post-setup failures are non-fatal (warn).
fn start_worktree_hook_mode<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    cli_branch_name: &str,
    flags: &StartFlags,
    opts: OutputOptions,
) -> Result<Outcome>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    // CLI name wins; otherwise read from stdin.
    let branch_name = if !cli_branch_name.is_empty() {
        cli_branch_name.to_string()
    } else {
        match read_worktree_hook_name(deps.io, deps.stdin) {
            Some(n) => n,
            None => {
                error_log(
                    deps.io,
                    "Error: --claude-code-worktree-hook requires a name via stdin or branch argument",
                );
                return Err(VibeError::AlreadyReported);
            }
        }
    };

    let repo_root = get_repo_root(deps.git)?;
    let repo_name = get_repo_name(deps.git)?;
    let sanitized = sanitize_branch_name(&branch_name);

    verbose_log(
        deps.io,
        &format!("[cc-worktree-hook] Repository root: {repo_root}"),
        opts,
    );
    verbose_log(
        deps.io,
        &format!("[cc-worktree-hook] Branch name: {branch_name}"),
        opts,
    );

    let validation = validate_branch_for_worktree(deps.git, &branch_name)?;

    if !validation.is_valid {
        let Some(existing) = validation.existing_worktree_path.clone() else {
            return Err(VibeError::Worktree(
                "Branch is in use but worktree path is unknown".to_string(),
            ));
        };
        verbose_log(
            deps.io,
            &format!("[cc-worktree-hook] Branch already in worktree: {existing}"),
            opts,
        );
        if flags.dry_run {
            return Ok(Outcome::none());
        }
        return Outcome::stdout_path(existing);
    }

    let base_ref = flags
        .base
        .as_ref()
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());
    if let Some(base) = &base_ref {
        if !validation.branch_exists && !revision_exists(deps.git, base) {
            error_log(deps.io, &format!("Error: Base '{base}' not found"));
            return Err(VibeError::AlreadyReported);
        }
    }

    let settings = load_user_settings(deps.io, deps.resolver, deps.version)?;
    let config = load_vibe_config(deps.io, deps.resolver, deps.version, &repo_root)?;

    let worktree_path = resolve_worktree_path(
        deps.io,
        deps.script_runner,
        config.as_ref(),
        &settings,
        &WorktreePathContext {
            repo_name,
            branch_name: branch_name.clone(),
            sanitized_branch: sanitized,
            repo_root: repo_root.clone(),
        },
    )?;

    verbose_log(
        deps.io,
        &format!("[cc-worktree-hook] Worktree path: {worktree_path}"),
        opts,
    );

    let conflict = check_worktree_conflict(deps.git, &worktree_path, &branch_name)?;

    if conflict.conflict_type == ConflictType::SameBranch {
        // Same non-fatal contract as the creation path below, including the
        // gated signal: re-entry hands back an existing worktree that a failing
        // `pre_start` left unprovisioned, so the caller must hear about it here
        // too. An `Err` is swallowed (only the path matters to the caller);
        // `warn_on_hook_failure` has already reported the cause.
        if let Ok(provisioning) = run_config_and_hooks(
            deps,
            config.as_ref(),
            &repo_root,
            &worktree_path,
            &ConfigAndHooks {
                skip_hooks: flags.no_hooks,
                skip_copy: flags.no_copy,
                copy_untracked: flags.copy_untracked,
                copy_modified: flags.copy_modified,
                dry_run: flags.dry_run,
                opts,
            },
        ) {
            if !provisioning.allows_cd() {
                deps.io.writeln_stderr(HOOK_MODE_GATED_SIGNAL);
            }
        }
        if flags.dry_run {
            return Ok(Outcome::none());
        }
        return Outcome::stdout_path(worktree_path);
    }

    if conflict.has_conflict {
        // Different branch at same path — force remove and recreate.
        remove_worktree(deps.git, &worktree_path, true)?;
    }

    let create_opts = CreateWorktreeOptions {
        branch_name: &branch_name,
        worktree_path: &worktree_path,
        branch_exists: validation.branch_exists,
        base_ref: base_ref.as_deref().filter(|_| !validation.branch_exists),
        track: flags.track,
    };

    if flags.dry_run {
        log_dry_run(
            deps.io,
            &format!(
                "[cc-worktree-hook] Would run: {}",
                get_create_worktree_command(&create_opts)
            ),
        );
        log_dry_run(
            deps.io,
            &format!("[cc-worktree-hook] Worktree path: {worktree_path}"),
        );
    } else {
        verbose_log(
            deps.io,
            &format!(
                "[cc-worktree-hook] Running: {}",
                get_create_worktree_command(&create_opts)
            ),
            opts,
        );
        create_worktree(deps.git, &create_opts)?;
    }

    // Post-setup is NON-FATAL in hook mode (warn but still output the path),
    // including a FATAL copy/submodule error — Claude Code has no shell to leave
    // in the wrong place, so the path is always emitted. A `Provisioning::Gated`
    // verdict does not change that either: the gate decides whether a `cd` is
    // safe, and this mode never emits one. What it does change is that the
    // worktree handed over is unprovisioned, so the caller is told so through
    // the fixed [`HOOK_MODE_GATED_SIGNAL`] line (issue #615) — exactly once,
    // since only `pre_start` can gate and the sequence runs once per invocation.
    match run_config_and_hooks(
        deps,
        config.as_ref(),
        &repo_root,
        &worktree_path,
        &ConfigAndHooks {
            skip_hooks: flags.no_hooks,
            skip_copy: flags.no_copy,
            copy_untracked: flags.copy_untracked,
            copy_modified: flags.copy_modified,
            dry_run: flags.dry_run,
            opts,
        },
    ) {
        Ok(provisioning) => {
            if !provisioning.allows_cd() {
                deps.io.writeln_stderr(HOOK_MODE_GATED_SIGNAL);
            }
        }
        Err(e) => warn_log(deps.io, &format!("Warning: Post-setup failed: {e}")),
    }

    if flags.dry_run {
        log_dry_run(
            deps.io,
            &format!("[cc-worktree-hook] Would output path: {worktree_path}"),
        );
        return Ok(Outcome::none());
    }

    // The hook protocol wants the PATH on stdout, NOT a cd.
    Outcome::stdout_path(worktree_path)
}

#[cfg(test)]
#[path = "start_tests.rs"]
mod tests;
