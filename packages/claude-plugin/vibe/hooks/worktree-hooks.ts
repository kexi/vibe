import type { On, PluginOptions } from "claude-code";

import {
  CLEAN_HOOK_ARGV,
  CLEAN_TIMEOUT_MS,
  START_HOOK_ARGV,
  START_TIMEOUT_MS,
  VERSION_ARGV,
  VERSION_TIMEOUT_MS,
  decideCreate,
  decideRemove,
  isVibe,
  probeFailure,
  settle,
} from "./vibe";

// Claude Code's WorktreeCreate / WorktreeRemove, answered by vibe: the same
// protocol the docs' settings.json hooks speak. Claude Code runs mods before
// the settings hooks, so answering here (without next) keeps a hook a user
// pasted into settings.json from running a second `vibe start` for the same
// worktree. Those settings hooks are still what covers `claude --worktree`:
// Claude Code creates that worktree while it starts, before any plugin loads.
//
// Each hook first asks `vibe --version` whether vibe can run here. Only when it
// cannot does the hook hand the event on to Claude Code's own git behavior:
// at that point vibe has done nothing, so nothing is done twice.
//
// Why there is no .catch on these hooks: a hook that throws is skipped and the
// next handler runs, which here means Claude Code creates or removes the
// worktree itself. Failing open is the intended fallback, not a hole to close.

export function registerWorktreeHooks(on: On, options: PluginOptions): void {
  // With the option off, Claude Code and any settings hooks handle both events
  // as if the plugin were not installed.
  const isEnabled = options.worktreeHooks === true;
  if (!isEnabled) return;

  on("classic.WorktreeCreate", async ($, e, next) => {
    const probe = await settle(
      $.process.run(VERSION_ARGV, { cwd: e.cwd, timeoutMs: VERSION_TIMEOUT_MS }),
    );
    if (!isVibe(probe)) {
      $.ui.toast("vibe could not run, so Claude Code created the worktree with git");
      $.ui.log("vibe start did not run: " + probeFailure(probe));
      return next(e);
    }

    // Only `name` is part of the protocol; the rest of the event (the
    // transcript path among it) has no business in another process's stdin.
    const outcome = await settle(
      $.process.run(START_HOOK_ARGV, {
        cwd: e.cwd,
        stdin: JSON.stringify({ name: e.name }),
        timeoutMs: START_TIMEOUT_MS,
      }),
    );
    const decision = decideCreate(outcome);

    if (decision.kind === "failed") {
      return { block: decision.reason };
    }
    if (!decision.isProvisioned) {
      $.ui.log("pre_start hook failed; " + decision.worktreePath + " is not provisioned");
    }
    return { worktreePath: decision.worktreePath };
  });

  on("classic.WorktreeRemove", async ($, e, next) => {
    // vibe clean must run inside the repository but outside the worktree it
    // removes; the main worktree's root is both, wherever the session stands.
    const repo = await $.session.repo();
    const cwd = repo?.root ?? e.cwd;
    const probe = await settle($.process.run(VERSION_ARGV, { cwd, timeoutMs: VERSION_TIMEOUT_MS }));
    if (!isVibe(probe)) {
      $.ui.log("vibe clean did not run: " + probeFailure(probe));
      return next(e);
    }

    const outcome = await settle(
      $.process.run(CLEAN_HOOK_ARGV, {
        cwd,
        stdin: JSON.stringify({ worktree_path: e.worktree_path }),
        timeoutMs: CLEAN_TIMEOUT_MS,
      }),
    );
    const decision = decideRemove(outcome);

    if (decision.kind === "failed") {
      return { block: decision.reason };
    }
    return {};
  });
}
