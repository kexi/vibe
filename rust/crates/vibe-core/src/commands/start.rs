//! `vibe start <branch>`: create or navigate to a worktree.
//!
//! Ported from `packages/core/src/commands/start.ts`. The validation cascade,
//! existing-branch navigate, same-branch idempotent re-entry, different-branch
//! Overwrite/Reuse/Cancel select, worktree creation, and the
//! pre_start → copy → post_start config-and-hooks sequence mirror the TS. The
//! Claude-Code `--claude-code-worktree-hook` mode reads a name from stdin and
//! outputs the worktree PATH to stdout (not a `cd`), with non-fatal post-setup.
//!
//! The single stdout write stays in the binary: a normal run returns
//! `Outcome::cd(path)`; the hook mode returns `Outcome::stdout(path)`.
//!
//! Seam strategy (architect's hybrid): the small, ubiquitous seams (`Io`,
//! `GitRunner`, `Prompt`, `RepoResolver`, `ScriptRunner`, `ProcessControl`) are
//! generic type params; the heavier copy/hook/progress/native seams are `&dyn`
//! to keep the generic surface from exploding.

use crate::commands::Outcome;
use crate::config::VibeConfig;
use crate::config_loader::load_vibe_config;
use crate::copy::strategies::CopyExecutor;
use crate::copy_runner::{copy_directories, copy_files, resolve_copy_concurrency};
use crate::error::{Result, VibeError};
use crate::git::{get_repo_name, get_repo_root, revision_exists, sanitize_branch_name, GitRunner};
use crate::hooks::{run_hooks, HookEnv, HookRunner, HookTrackerInfo};
use crate::io::Io;
use crate::output::{error_log, log, log_dry_run, verbose_log, warn_log, OutputOptions};
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

/// Flags controlling a `start` run (mirrors the TS `StartOptions`).
#[derive(Debug, Clone, Default)]
pub struct StartFlags {
    pub no_hooks: bool,
    pub no_copy: bool,
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
    pub tracker: &'a (dyn ProgressTracker + Sync),
    pub version: &'a str,
}

/// Options bundle passed into the config-and-hooks helper.
struct ConfigAndHooks {
    skip_hooks: bool,
    skip_copy: bool,
    dry_run: bool,
}

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

    if !validation.is_valid {
        let Some(existing) = validation.existing_worktree_path.clone() else {
            return Err(VibeError::Worktree(
                "Branch is in use but worktree path is unknown".to_string(),
            ));
        };
        if let Some(outcome) = handle_existing_branch_worktree(deps, branch_name, &existing, flags)?
        {
            return Ok(outcome);
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
        create_worktree(deps.git, &create_opts)?;
    }

    run_config_and_hooks(
        deps,
        config.as_ref(),
        &repo_root,
        &worktree_path,
        &ConfigAndHooks {
            skip_hooks: flags.no_hooks,
            skip_copy: flags.no_copy,
            dry_run: flags.dry_run,
        },
    )?;

    if flags.dry_run {
        log_dry_run(
            deps.io,
            &format!("Would change directory to: {worktree_path}"),
        );
        return Ok(Outcome::none());
    }

    Ok(Outcome::cd(worktree_path))
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

/// Handle a branch already used by another worktree. Returns `Some(outcome)`
/// when fully handled.
fn handle_existing_branch_worktree<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    branch_name: &str,
    existing: &str,
    flags: &StartFlags,
) -> Result<Option<Outcome>>
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
        return Ok(Some(Outcome::none()));
    }

    if flags.force {
        return Ok(Some(Outcome::cd(existing.to_string())));
    }

    let navigate = deps.prompt.confirm(&format!(
        "Branch '{branch_name}' is already used in worktree '{existing}'.\nNavigate to the existing worktree? (Y/n)"
    ));
    if navigate {
        Ok(Some(Outcome::cd(existing.to_string())))
    } else {
        log(deps.io, "Cancelled", OutputOptions::new(false, false));
        Ok(Some(Outcome::none()))
    }
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
        run_config_and_hooks(
            deps,
            config,
            repo_root,
            worktree_path,
            &ConfigAndHooks {
                skip_hooks: flags.no_hooks,
                skip_copy: flags.no_copy,
                dry_run: true,
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
    run_config_and_hooks(
        deps,
        config,
        repo_root,
        worktree_path,
        &ConfigAndHooks {
            skip_hooks: flags.no_hooks,
            skip_copy: flags.no_copy,
            dry_run: false,
        },
    )?;
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
        1 => {
            // Reuse: skip creation, run hooks/config, cd.
            run_config_and_hooks(
                deps,
                config,
                repo_root,
                worktree_path,
                &ConfigAndHooks {
                    skip_hooks: flags.no_hooks,
                    skip_copy: flags.no_copy,
                    dry_run: false,
                },
            )?;
            Ok(ConflictDecision::Done(Outcome::cd(
                worktree_path.to_string(),
            )))
        }
        _ => {
            // Cancel.
            log(deps.io, "Cancelled", OutputOptions::new(false, false));
            Ok(ConflictDecision::Done(Outcome::none()))
        }
    }
}

/// Run config-driven hooks + copy: pre_start (in repo_root) → copy files + dirs →
/// post_start (in worktree_path).
fn run_config_and_hooks<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    config: Option<&VibeConfig>,
    repo_root: &str,
    worktree_path: &str,
    options: &ConfigAndHooks,
) -> Result<()>
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
    let Some(config) = config else {
        // No config → nothing to copy, but pre_start hooks could still be absent.
        return Ok(());
    };

    let has_ops = !options.dry_run && config_has_operations(config, options);
    if has_ops {
        deps.tracker.start();
    }

    // pre_start hooks (in repo_root).
    if !options.skip_hooks {
        run_lifecycle_hooks(
            deps,
            config.hooks.as_ref().and_then(|h| h.pre_start.as_deref()),
            "Pre-start hooks",
            "pre-start",
            repo_root,
            worktree_path,
            repo_root,
            options.dry_run,
        )?;
    }

    // copy files + directories.
    if !options.skip_copy {
        copy_files(
            deps.io,
            &deps.executor,
            deps.tracker,
            config
                .copy
                .as_ref()
                .and_then(|c| c.files.as_deref())
                .unwrap_or(&[]),
            repo_root,
            worktree_path,
            options.dry_run,
        );

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
                repo_root,
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

    // post_start hooks (in worktree_path).
    if !options.skip_hooks {
        run_lifecycle_hooks(
            deps,
            config.hooks.as_ref().and_then(|h| h.post_start.as_deref()),
            "Post-start hooks",
            "post-start",
            worktree_path,
            worktree_path,
            repo_root,
            options.dry_run,
        )?;
    }

    if has_ops {
        deps.tracker.finish();
    }

    Ok(())
}

/// Whether config has any hook/copy operation (drives starting the tracker).
fn config_has_operations(config: &VibeConfig, options: &ConfigAndHooks) -> bool {
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
            })
            .unwrap_or(0)
    };
    hooks_count + copy_count > 0
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
            log_dry_run(deps.io, &format!("  - {hook}"));
        }
        return Ok(());
    }

    let phase = deps.tracker.add_phase(phase_label);
    let task_ids: Vec<_> = hooks
        .iter()
        .map(|h| deps.tracker.add_task(phase, h))
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
        return Ok(Outcome::stdout(existing));
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
        let _ = run_config_and_hooks(
            deps,
            config.as_ref(),
            &repo_root,
            &worktree_path,
            &ConfigAndHooks {
                skip_hooks: flags.no_hooks,
                skip_copy: flags.no_copy,
                dry_run: flags.dry_run,
            },
        );
        if flags.dry_run {
            return Ok(Outcome::none());
        }
        return Ok(Outcome::stdout(worktree_path));
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

    // Post-setup is NON-FATAL in hook mode (warn but still output the path).
    if let Err(e) = run_config_and_hooks(
        deps,
        config.as_ref(),
        &repo_root,
        &worktree_path,
        &ConfigAndHooks {
            skip_hooks: flags.no_hooks,
            skip_copy: flags.no_copy,
            dry_run: flags.dry_run,
        },
    ) {
        warn_log(deps.io, &format!("Warning: Post-setup failed: {e}"));
    }

    if flags.dry_run {
        log_dry_run(
            deps.io,
            &format!("[cc-worktree-hook] Would output path: {worktree_path}"),
        );
        return Ok(Outcome::none());
    }

    // The hook protocol wants the PATH on stdout, NOT a cd.
    Ok(Outcome::stdout(worktree_path))
}

#[cfg(test)]
#[path = "start_tests.rs"]
mod tests;
