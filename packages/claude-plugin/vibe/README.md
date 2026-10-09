# vibe plugin for Claude Code

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that
lets [vibe](https://vibe.kexi.dev) create and clean the git worktrees Claude
Code makes during a session, so they get vibe's copy-on-write file copies and
your `.vibe.toml` hooks, and adds a `/vibe` pane that lists them.

## Install

```bash
claude plugin install vibe --marketplace kexi/vibe
```

Or, in a Claude Code session: `/plugin install vibe --marketplace kexi/vibe`.
The marketplace installs the plugin as of vibe's latest release tag, never
from `main` between releases.

The plugin runs the `vibe` binary on your `PATH`, so install vibe itself first
(see [Installation](https://vibe.kexi.dev/installation/)).

## What it does

- **WorktreeCreate**: when Claude Code creates a worktree during a session (the
  `EnterWorktree` tool, or a subagent with `isolation: worktree`), the plugin
  runs `vibe start --claude-code-worktree-hook` and hands Claude Code the path
  vibe prints.
- **WorktreeRemove**: when Claude Code removes such a worktree, the plugin runs
  `vibe clean --claude-code-worktree-hook` from the main worktree.
- **`/vibe`**: opens a pane listing this repository's worktrees as `vibe list`
  shows them, with a button to copy each path and one to remove a worktree
  (it asks first, and says how many uncommitted changes a removal discards).
  The pane reads the listing again after every turn while it is open.

Before each event the plugin runs `vibe --version`. If vibe cannot run (for
example, it is not on `PATH`), Claude Code creates or removes the worktree
itself and the plugin shows a notice. If vibe runs and fails, or does not
finish in time, the worktree is not created and Claude Code shows the reason.

### `claude --worktree` still needs the settings hooks

Claude Code creates the worktree for `claude --worktree <name>` while it starts,
before it loads plugins, so no plugin can take that one over. To have vibe
create it too, keep the `WorktreeCreate` / `WorktreeRemove` hooks from
[Claude Code Integration](https://vibe.kexi.dev/configuration/hooks/#claude-code-integration)
in your `settings.json`.

The two do not run twice: during a session the plugin answers the event first,
and Claude Code then skips the settings hooks for it.

## Settings

| Option          | Default | What it does                                                                     |
| --------------- | ------- | -------------------------------------------------------------------------------- |
| `worktreeHooks` | `true`  | Let vibe create and clean Claude Code's worktrees. Turn off to leave them to git. |

Change it with `/config` in a Claude Code session. The `/vibe` pane works
either way.

## Compatibility

Tested with Claude Code 2.1.292. Mods need Claude Code 2.1.287 or later.
