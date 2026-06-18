//! `vibe clean`: remove the current worktree and return to main.
//!
//! Ported from `packages/core/src/commands/clean.ts`. The broken-link guard,
//! not-main guard, uncommitted-changes confirm/force, pre_clean hooks (in the
//! worktree), chdir-to-main (fatal on failure), fast-remove-or-traditional
//! remove, post_clean hooks (in main), delete-branch precedence, and the final
//! `cd main` mirror the TS. The `--claude-code-worktree-hook` mode reads a path
//! from stdin and, before fast-removing, CONTAINMENT-CHECKS it against the git
//! worktree set (security #3, a divergence from the TS — non-fatal: a path not in
//! the set is skipped rather than removed).
//!
//! `clean.fast_remove` is read from `VibeSettings.extra["clean"]["fast_remove"]`
//! (default true), preserving the settings round-trip (the `clean` section stays
//! in `extra`).

use crate::clock::{Clock, RandomSource};
use crate::commands::{Outcome, ProcessControl};
use crate::config::VibeConfig;
use crate::config_loader::load_vibe_config;
use crate::copy::native::NativeClone;
use crate::error::{Result, VibeError};
use crate::fast_remove::{
    cleanup_stale_trash, fast_remove_directory, is_fast_remove_supported, BackgroundSpawner,
};
use crate::git::{
    detect_broken_worktree_link, get_main_worktree_path, get_repo_root, get_worktree_by_path,
    get_worktree_list, has_uncommitted_changes, is_main_worktree, GitRunner,
};
use crate::hooks::{run_hooks, HookEnv, HookRunner, HookTrackerInfo};
use crate::io::Io;
use crate::output::{error_log, log, success_log, verbose_log, warn_log, OutputOptions};
use crate::progress::ProgressTracker;
use crate::prompt::Prompt;
use crate::settings::{RepoResolver, VibeSettings};
use crate::settings_io::load_user_settings;
use crate::stdin::{read_worktree_hook_path, StdinReader};
use std::path::Path;

/// Flags controlling a `clean` run.
#[derive(Debug, Clone, Default)]
pub struct CleanFlags {
    pub force: bool,
    pub delete_branch: bool,
    pub keep_branch: bool,
    pub worktree_hook: bool,
}

/// Bundled seams for `clean`.
pub struct CleanDeps<'a, I, G, R, P, Pc, Sr>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    P: Prompt,
    Pc: ProcessControl,
    Sr: StdinReader,
{
    pub io: &'a I,
    pub git: &'a G,
    pub resolver: &'a R,
    pub prompt: &'a P,
    pub process: &'a Pc,
    pub stdin: &'a Sr,
    pub hook_runner: &'a dyn HookRunner,
    pub native: &'a dyn NativeClone,
    pub spawner: &'a dyn BackgroundSpawner,
    pub tracker: &'a dyn ProgressTracker,
    pub clock: &'a dyn Clock,
    pub random: &'a dyn RandomSource,
    /// Process cwd (for the broken-link guard's recovery message).
    pub cwd: &'a str,
    pub version: &'a str,
}

/// Run `vibe clean`.
pub fn clean_command<I, G, R, P, Pc, Sr>(
    deps: &CleanDeps<I, G, R, P, Pc, Sr>,
    flags: &CleanFlags,
    opts: OutputOptions,
) -> Result<Outcome>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    P: Prompt,
    Pc: ProcessControl,
    Sr: StdinReader,
{
    if flags.worktree_hook {
        return clean_worktree_hook_mode(deps, flags, opts);
    }

    // Broken-link guard.
    let link = detect_broken_worktree_link(Path::new(deps.cwd));
    if link.is_broken {
        let git_dir = link.git_dir.unwrap_or_default();
        return Err(VibeError::Worktree(format!(
            "The main worktree appears to have been deleted.\nExpected git directory: {git_dir}\n\nTo clean up manually:\n  1. Remove this worktree directory: rm -rf '{}'\n  2. If the main repository still exists elsewhere, run: git worktree prune\n\nThis worktree cannot be cleaned automatically because the git repository link is broken.",
            deps.cwd
        )));
    }

    // Not-main guard.
    if is_main_worktree(deps.git)? {
        error_log(
            deps.io,
            "Error: Cannot clean main worktree. Use this command from a secondary worktree.",
        );
        return Err(VibeError::AlreadyReported);
    }

    // Uncommitted-changes confirm / force.
    let mut force_remove = false;
    if has_uncommitted_changes(deps.git)? {
        if flags.force {
            force_remove = true;
        } else {
            let cont = deps.prompt.confirm(
                "Warning: This worktree has uncommitted changes. Do you want to continue? (Y/n)",
            );
            if !cont {
                log(deps.io, "Clean operation cancelled.", opts);
                return Ok(Outcome::none());
            }
            force_remove = true;
        }
    }

    let current_worktree_path = get_repo_root(deps.git)?;
    let main_path = get_main_worktree_path(deps.git)?;

    let worktree_info = get_worktree_by_path(deps.git, &current_worktree_path)?;
    let Some(worktree_info) = worktree_info else {
        // Already removed by another process.
        success_log(deps.io, "Worktree already removed.", opts);
        return Ok(Outcome::cd(main_path));
    };
    let current_branch = worktree_info.branch;

    let config = load_vibe_config(deps.io, deps.resolver, deps.version, &current_worktree_path)?;

    // pre_clean hooks (in the worktree).
    run_lifecycle_hooks(
        deps,
        config
            .as_ref()
            .and_then(|c| c.hooks.as_ref())
            .and_then(|h| h.pre_clean.as_deref()),
        "Pre-clean hooks",
        &current_worktree_path,
        &current_worktree_path,
        &main_path,
    )?;

    // chdir to main BEFORE removing (fatal on failure).
    if deps.process.chdir(&main_path).is_err() {
        error_log(
            deps.io,
            &format!("Error: Cannot change to main worktree: {main_path}"),
        );
        return Err(VibeError::AlreadyReported);
    }

    let settings = load_user_settings(deps.io, deps.resolver, deps.version)?;
    let use_fast_remove = clean_fast_remove(&settings);

    remove_worktree(
        deps,
        &main_path,
        &current_worktree_path,
        force_remove,
        use_fast_remove,
        opts,
    )?;

    // post_clean hooks (in main).
    run_post_clean_hooks(deps, config.as_ref(), &current_worktree_path, &main_path)?;

    success_log(
        deps.io,
        &format!("Worktree {current_worktree_path} has been removed."),
        opts,
    );

    maybe_delete_branch(
        deps,
        config.as_ref(),
        &main_path,
        &current_branch,
        flags,
        opts,
        false,
    );

    Ok(Outcome::cd(main_path))
}

/// Whether to use fast remove: `settings.extra["clean"]["fast_remove"]`, default
/// true. The `clean` section lives in `extra` (round-trip preserved).
fn clean_fast_remove(settings: &VibeSettings) -> bool {
    settings
        .extra
        .get("clean")
        .and_then(|c| c.get("fast_remove"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Remove the worktree via fast-remove (mv + async delete) or traditional
/// `git worktree remove`. Ported from clean.ts `removeWorktree`.
fn remove_worktree<I, G, R, P, Pc, Sr>(
    deps: &CleanDeps<I, G, R, P, Pc, Sr>,
    main_path: &str,
    worktree_path: &str,
    force_remove: bool,
    use_fast_remove: bool,
    opts: OutputOptions,
) -> Result<()>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    P: Prompt,
    Pc: ProcessControl,
    Sr: StdinReader,
{
    let should_fast = use_fast_remove && is_fast_remove_supported();

    if should_fast {
        verbose_log(deps.io, "Using fast remove (mv + async delete)", opts);

        // Read the `.git` file content before moving (needed to recreate it).
        let git_file_path = Path::new(worktree_path).join(".git");
        let git_file_content = std::fs::read_to_string(&git_file_path).ok();

        if let Some(content) = git_file_content {
            let result = fast_remove_directory(
                deps.io,
                &deps.native,
                &deps.spawner,
                &deps.clock,
                &deps.random,
                worktree_path,
                opts,
            );

            if result.success {
                // Recreate an empty dir + `.git` so `git worktree remove` works.
                if let Err(e) = std::fs::create_dir(worktree_path) {
                    if e.kind() != std::io::ErrorKind::AlreadyExists {
                        return Err(VibeError::FileSystem(format!(
                            "Failed to recreate worktree directory: {e}"
                        )));
                    }
                }

                match std::fs::write(&git_file_path, &content) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        verbose_log(deps.io, "Worktree already removed by another process", opts);
                        return Ok(());
                    }
                    Err(e) => {
                        return Err(VibeError::FileSystem(format!(
                            "Failed to recreate .git file: {e}"
                        )));
                    }
                }

                // `git -C main worktree remove --force -- <path>` on the empty dir.
                verbose_log(
                    deps.io,
                    &format!(
                        "Running: git -C {main_path} worktree remove --force -- {worktree_path}"
                    ),
                    opts,
                );
                match deps.git.run(&[
                    "-C",
                    main_path,
                    "worktree",
                    "remove",
                    "--force",
                    "--",
                    worktree_path,
                ]) {
                    Ok(_) => {}
                    Err(e) => {
                        let msg = e.to_string();
                        let already_removed = msg.contains("not a working tree")
                            || msg.contains("does not exist")
                            || msg.contains("is not a valid path");
                        if already_removed {
                            verbose_log(deps.io, "Worktree already removed from git", opts);
                            return Ok(());
                        }
                        return Err(e);
                    }
                }

                // Background-cleanup stale trash in the parent dir.
                let parent = Path::new(worktree_path)
                    .parent()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|| ".".to_string());
                cleanup_stale_trash(deps.io, &deps.spawner, &parent);
                return Ok(());
            }

            // Fast remove failed → fall back to traditional.
            verbose_log(
                deps.io,
                &format!(
                    "Fast remove failed: {}, falling back to git worktree remove",
                    result.error.unwrap_or_default()
                ),
                opts,
            );
        }
    }

    // Traditional `git -C main worktree remove [--force] -- <path>`.
    let mut args: Vec<&str> = vec!["-C", main_path, "worktree", "remove"];
    if force_remove {
        args.push("--force");
    }
    args.push("--");
    args.push(worktree_path);
    verbose_log(deps.io, &format!("Running: git {}", args.join(" ")), opts);
    deps.git.run(&args)?;
    Ok(())
}

/// Run pre/post clean hooks helper (shared shape).
///
/// DELIBERATE asymmetry vs `start`'s `run_lifecycle_hooks`: here the tracker's
/// `start()`/`finish()` lifecycle is owned INSIDE this helper (clean has no
/// outer config-and-hooks wrapper). In `start`, the tracker is managed by
/// `run_config_and_hooks` around the hook calls. Do not "unify" the two.
fn run_lifecycle_hooks<I, G, R, P, Pc, Sr>(
    deps: &CleanDeps<I, G, R, P, Pc, Sr>,
    hooks: Option<&[String]>,
    phase_label: &str,
    cwd: &str,
    worktree_path: &str,
    origin_path: &str,
) -> Result<()>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    P: Prompt,
    Pc: ProcessControl,
    Sr: StdinReader,
{
    let Some(hooks) = hooks.filter(|h| !h.is_empty()) else {
        return Ok(());
    };
    deps.tracker.start();
    let phase = deps.tracker.add_phase(phase_label);
    let task_ids: Vec<_> = hooks
        .iter()
        .map(|h| deps.tracker.add_task(phase, h))
        .collect();
    let info = HookTrackerInfo {
        tracker: deps.tracker,
        task_ids: &task_ids,
    };
    let res = run_hooks(
        deps.io,
        &deps.hook_runner,
        hooks,
        cwd,
        &HookEnv {
            worktree_path,
            origin_path,
        },
        Some(&info),
    );
    deps.tracker.finish();
    res
}

/// post_clean hooks run from main WITHOUT a tracker (TS passes `undefined`).
fn run_post_clean_hooks<I, G, R, P, Pc, Sr>(
    deps: &CleanDeps<I, G, R, P, Pc, Sr>,
    config: Option<&VibeConfig>,
    worktree_path: &str,
    main_path: &str,
) -> Result<()>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    P: Prompt,
    Pc: ProcessControl,
    Sr: StdinReader,
{
    let hooks = config
        .and_then(|c| c.hooks.as_ref())
        .and_then(|h| h.post_clean.as_deref());
    let Some(hooks) = hooks.filter(|h| !h.is_empty()) else {
        return Ok(());
    };
    run_hooks(
        deps.io,
        &deps.hook_runner,
        hooks,
        main_path,
        &HookEnv {
            worktree_path,
            origin_path: main_path,
        },
        None,
    )
}

/// Delete-branch precedence: CLI delete > CLI keep > config > default false.
/// Best-effort: a failure warns, never errors.
#[allow(clippy::too_many_arguments)]
fn maybe_delete_branch<I, G, R, P, Pc, Sr>(
    deps: &CleanDeps<I, G, R, P, Pc, Sr>,
    config: Option<&VibeConfig>,
    main_path: &str,
    branch: &str,
    flags: &CleanFlags,
    opts: OutputOptions,
    hook_mode: bool,
) where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    P: Prompt,
    Pc: ProcessControl,
    Sr: StdinReader,
{
    let should_delete = if flags.delete_branch {
        true
    } else if flags.keep_branch {
        false
    } else {
        config
            .and_then(|c| c.clean.as_ref())
            .and_then(|c| c.delete_branch)
            .unwrap_or(false)
    };

    if !should_delete || branch.is_empty() {
        return;
    }

    match deps
        .git
        .run(&["-C", main_path, "branch", "-d", "--", branch])
    {
        Ok(_) => {
            if hook_mode {
                verbose_log(
                    deps.io,
                    &format!("[cc-worktree-hook] Branch {branch} deleted."),
                    opts,
                );
            } else {
                success_log(deps.io, &format!("Branch {branch} has been deleted."), opts);
            }
        }
        Err(e) => {
            warn_log(
                deps.io,
                &format!("Warning: Could not delete branch {branch}: {e}"),
            );
            if !hook_mode {
                warn_log(
                    deps.io,
                    &format!("You may need to delete it manually with: git branch -D {branch}"),
                );
            }
        }
    }
}

/// Claude-Code WorktreeRemove hook mode: path from stdin, with a CONTAINMENT
/// check against the git worktree set (security #3) before fast-removing.
fn clean_worktree_hook_mode<I, G, R, P, Pc, Sr>(
    deps: &CleanDeps<I, G, R, P, Pc, Sr>,
    flags: &CleanFlags,
    opts: OutputOptions,
) -> Result<Outcome>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    P: Prompt,
    Pc: ProcessControl,
    Sr: StdinReader,
{
    let Some(worktree_path) = read_worktree_hook_path(deps.io, deps.stdin) else {
        error_log(
            deps.io,
            "Error: --claude-code-worktree-hook requires worktree_path via stdin",
        );
        return Err(VibeError::AlreadyReported);
    };

    let main_path = get_main_worktree_path(deps.git)?;

    verbose_log(
        deps.io,
        &format!("[cc-worktree-hook] Worktree path: {worktree_path}"),
        opts,
    );
    verbose_log(
        deps.io,
        &format!("[cc-worktree-hook] Main path: {main_path}"),
        opts,
    );

    // SECURITY #3 (divergence from TS): containment-check the stdin path against
    // the actual git worktree set BEFORE touching it. A path not in the set is
    // refused (non-fatal) rather than blindly removed. This runs FIRST — even
    // before the already-removed check — so an attacker-supplied outside path can
    // never reach the removal logic.
    let known = get_worktree_list(deps.git)?;
    let contained = known.iter().any(|w| {
        crate::git::lexical_normalize_path(&w.path)
            == crate::git::lexical_normalize_path(&worktree_path)
    });
    if !contained {
        warn_log(
            deps.io,
            &format!(
                "Warning: refusing to clean a path not in the git worktree set: {worktree_path}"
            ),
        );
        return Ok(Outcome::none());
    }

    let worktree_info = get_worktree_by_path(deps.git, &worktree_path)?;
    let Some(worktree_info) = worktree_info else {
        verbose_log(deps.io, "[cc-worktree-hook] Worktree already removed", opts);
        return Ok(Outcome::none());
    };
    let current_branch = worktree_info.branch;

    let config = load_vibe_config(deps.io, deps.resolver, deps.version, &worktree_path)?;

    // pre_clean hooks (in the worktree being removed).
    run_lifecycle_hooks(
        deps,
        config
            .as_ref()
            .and_then(|c| c.hooks.as_ref())
            .and_then(|h| h.pre_clean.as_deref()),
        "Pre-clean hooks",
        &worktree_path,
        &worktree_path,
        &main_path,
    )?;

    let settings = load_user_settings(deps.io, deps.resolver, deps.version)?;
    let use_fast_remove = clean_fast_remove(&settings);

    // Best-effort chdir to main (non-fatal here, unlike the normal path).
    if deps.process.chdir(&main_path).is_err() {
        verbose_log(
            deps.io,
            &format!("[cc-worktree-hook] Could not chdir to {main_path}"),
            opts,
        );
    }

    // Always force in hook mode (Claude Code is controlling this).
    remove_worktree(
        deps,
        &main_path,
        &worktree_path,
        true,
        use_fast_remove,
        opts,
    )?;

    run_post_clean_hooks(deps, config.as_ref(), &worktree_path, &main_path)?;

    verbose_log(
        deps.io,
        &format!("[cc-worktree-hook] Worktree {worktree_path} removed."),
        opts,
    );

    maybe_delete_branch(
        deps,
        config.as_ref(),
        &main_path,
        &current_branch,
        flags,
        opts,
        true,
    );

    // Hook mode emits NO cd (Claude Code controls navigation).
    Ok(Outcome::none())
}

#[cfg(test)]
#[path = "clean_tests.rs"]
mod tests;
