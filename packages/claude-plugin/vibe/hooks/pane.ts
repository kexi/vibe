import type { EngineInterface, On } from "claude-code";

import {
  LIST_ARGV,
  LIST_TIMEOUT_MS,
  type Worktree,
  describeListFailure,
  formatRows,
  parseVibeList,
  removalQuestion,
} from "./list";
import { CLEAN_HOOK_ARGV, CLEAN_TIMEOUT_MS, decideRemove, settle } from "./vibe";

// The /vibe command and the pane it opens: this repository's worktrees as
// `vibe list` sees them, with a button to copy each path and one to remove a
// worktree.

const PANE = "vibe";
const REMOVE = "Remove";
const KEEP = "Keep";

// What the pane draws. Why module variables rather than $.state: the listing
// is read from vibe again every time the pane opens, so a value that survives a
// module reload would buy nothing.
let worktrees: Worktree[] = [];
let failure: string | null = null;
let repoRoot: string | null = null;
let isLoading = false;

/** Reads the listing from vibe again and redraws the pane. */
async function refresh($: EngineInterface): Promise<void> {
  isLoading = true;
  $.ui.invalidate("ui.render");

  const repo = await $.session.repo();
  repoRoot = repo?.root ?? null;
  const outcome = await settle(
    $.process.run(LIST_ARGV, { cwd: repoRoot ?? undefined, timeoutMs: LIST_TIMEOUT_MS }),
  );

  const isListed = outcome.kind === "ran" && outcome.exitCode === 0;
  const listing = isListed ? parseVibeList(outcome.stderr) : null;
  if (listing === null) {
    worktrees = [];
    failure = isListed ? "vibe list printed no listing to read." : describeListFailure(outcome);
  } else {
    worktrees = listing;
    failure = null;
  }
  isLoading = false;
  $.ui.invalidate("ui.render");
}

/** Asks, then removes one worktree through vibe and reads the listing again. */
async function remove($: EngineInterface, worktree: Worktree): Promise<void> {
  let answer = KEEP;
  try {
    answer = await $.ui.ask(removalQuestion(worktree), [REMOVE, KEEP]);
  } catch {
    // Dismissed, or nobody to ask: keep the worktree.
  }
  const isConfirmed = answer === REMOVE;
  if (!isConfirmed) return;

  // The same `vibe clean` mode Claude Code's WorktreeRemove uses: it is the one
  // that removes a worktree other than the one it runs in, and it runs the
  // repository's pre_clean / post_clean hooks.
  const outcome = await settle(
    $.process.run(CLEAN_HOOK_ARGV, {
      cwd: repoRoot ?? undefined,
      stdin: JSON.stringify({ worktree_path: worktree.path }),
      timeoutMs: CLEAN_TIMEOUT_MS,
    }),
  );
  const decision = decideRemove(outcome);
  if (decision.kind !== "removed") {
    $.ui.toast("vibe clean failed: " + decision.reason);
  }
  await refresh($);
}

export function registerPane(on: On): void {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "vibe",
      description: "Show this repository's worktrees (vibe list)",
      immediate: true,
    });
    return next(e);
  });

  on("command.run", { command: "vibe" }, async ($) => {
    await $.ui.open({ id: PANE, title: "vibe worktrees", focus: true, closeOnEscape: true });
    await refresh($);
    return {};
  });

  // A turn can create, remove or dirty a worktree, so an open pane reads the
  // listing again. Not awaited: the turn's end must not wait on `vibe list`.
  on("turn.complete", async ($, e, next) => {
    const panes = await $.ui.panes();
    const isOpen = panes.some((pane) => pane.id === PANE);
    if (isOpen) void refresh($);
    return next(e);
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const now = await $.clock.now();

    const header = Box({
      flexDirection: "row",
      columnGap: 2,
      children: [
        Button({
          key: "refresh",
          label: "Refresh",
          hotkey: "r",
          plain: true,
          onPress: () => refresh($),
        }),
        Text({
          dimColor: true,
          wrap: "truncate-middle",
          children: [isLoading ? "reading vibe list…" : (repoRoot ?? "")],
        }),
      ],
    });

    if (failure !== null) {
      return Box({
        flexDirection: "column",
        children: [header, Text({ color: "error", children: [failure] })],
      });
    }

    const labels = formatRows(worktrees, now);
    const rows = worktrees.map((worktree, i) => {
      // No remove button for the main worktree, which holds the repository
      // itself, or for the current one, which the session is standing in.
      const isRemovable = !worktree.isCurrent && worktree.path !== repoRoot;
      const label = labels[i] ?? "";
      // Two lines per worktree: vibe list's columns with the buttons, then the
      // path under them, so a narrow pane truncates the path instead of
      // wrapping the columns.
      return Box({
        key: "row-" + worktree.path,
        flexDirection: "column",
        children: [
          Box({
            flexDirection: "row",
            columnGap: 2,
            children: [
              Text({ bold: worktree.isCurrent, wrap: "truncate-end", children: [label] }),
              Button({
                key: "copy-" + worktree.path,
                label: "copy",
                plain: true,
                onPress: async () => {
                  await $.ui.copy({ text: worktree.path });
                },
              }),
              ...(isRemovable
                ? [
                    Button({
                      key: "remove-" + worktree.path,
                      label: "remove",
                      plain: true,
                      onPress: () => remove($, worktree),
                    }),
                  ]
                : []),
            ],
          }),
          Box({
            paddingLeft: 3,
            children: [
              Text({
                dimColor: true,
                wrap: "truncate-middle",
                children: [worktree.path + (worktree.isScratch ? " (scratch)" : "")],
              }),
            ],
          }),
        ],
      });
    });

    return Box({ flexDirection: "column", children: [header, ...rows] });
  });
}
