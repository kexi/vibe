import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

// What Claude Code passes a ui.render hook for the /vibe pane, apart from the app
const PANE = {
  plugin: "vibe",
  component: "Pane",
  requestId: "vibe",
  viewport: { columns: 120, rows: 40 },
  props: {
    title: "vibe worktrees",
    isFocused: true,
    bodyColumns: 100,
    placement: "inline",
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const;

const REPO = { root: "/work/repo", remote: null, internal: false, name: null };

// The user typing /vibe into the prompt of a 120-column terminal
const RUN_VIBE = {
  command: "vibe",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 120 },
} as const;

// `vibe list --json` for a repository with its main worktree, the worktree the
// session stands in, and one more
const LISTING = JSON.stringify([
  {
    branch: "main",
    path: "/work/repo",
    current: false,
    scratch: false,
    base: null,
    status: "clean",
    dirty_files: 0,
  },
  {
    branch: "feat/a",
    path: "/work/repo-feat-a",
    current: true,
    scratch: false,
    base: "main",
    status: "clean",
    dirty_files: 0,
  },
  {
    branch: "feat/b",
    path: "/work/repo-feat-b",
    current: false,
    scratch: false,
    base: "main",
    status: "dirty",
    dirty_files: 2,
  },
]);

const ran = (exitCode: number, stdout: string, stderr = "") => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
});

interface Run {
  argv: readonly string[];
  init: { cwd?: string; stdin?: string };
}

/** Stubs every call the pane makes; `list` answers `vibe list`, any other command exits 0. */
function stubPane(on: On, list: ReturnType<typeof ran> | { deny: string }) {
  const runs: Run[] = [];
  mock.clock(on);
  on("session.repo", () => ({ value: REPO }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.toast", () => ({ value: undefined }));
  on("process.run", ($, e) => {
    runs.push({ argv: e.argv, init: e.init ?? {} });
    return e.argv[1] === "list" ? list : ran(0, "");
  });
  return runs;
}

test("/vibe lists every worktree vibe list reports", async ($, on) => {
  stubPane(on, ran(0, "", LISTING));

  await $.command.run(RUN_VIBE);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });

  expect(await ui.find({ type: "Text", text: /feat\/b .*M 2/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: "/work/repo-feat-a" })).toBeDefined();
  expect(await ui.find({ key: "copy-/work/repo" })).toBeDefined();
});

test("the pane offers no remove button for the main or the current worktree", async ($, on) => {
  stubPane(on, ran(0, "", LISTING));

  await $.command.run(RUN_VIBE);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });

  expect(await ui.find({ key: "remove-/work/repo" })).toBeUndefined();
  expect(await ui.find({ key: "remove-/work/repo-feat-a" })).toBeUndefined();
  expect(await ui.find({ key: "remove-/work/repo-feat-b" })).toBeDefined();
});

test("remove asks first, then runs vibe clean on that worktree from the main worktree", async ($, on) => {
  const runs = stubPane(on, ran(0, "", LISTING));
  let question = "";
  on("tool.call", { tool: "AskUserQuestion" }, ($, e) => {
    question = e.questions[0]?.question ?? "";
    return { result: { answers: { [question]: "Remove" } } };
  });

  await $.command.run(RUN_VIBE);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "remove-/work/repo-feat-b" });

  expect(question).toMatch(/2 uncommitted change/);
  const clean = runs.find((run) => run.argv[1] === "clean");
  expect(clean?.argv).toEqual(["vibe", "clean", "--claude-code-worktree-hook"]);
  expect(clean?.init.cwd).toBe("/work/repo");
  expect(JSON.parse(clean?.init.stdin ?? "")).toEqual({ worktree_path: "/work/repo-feat-b" });
});

test("remove does nothing when the user keeps the worktree", async ($, on) => {
  const runs = stubPane(on, ran(0, "", LISTING));
  on("tool.call", { tool: "AskUserQuestion" }, ($, e) => ({
    result: { answers: { [e.questions[0]?.question ?? ""]: "Keep" } },
  }));

  await $.command.run(RUN_VIBE);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "remove-/work/repo-feat-b" });

  expect(runs.some((run) => run.argv[1] === "clean")).toBe(false);
});

test("the pane shows vibe's own message when vibe list fails", async ($, on) => {
  stubPane(
    on,
    ran(1, "", ".vibe.toml file is not trusted or has been modified.\nPlease run: vibe trust\n"),
  );

  await $.command.run(RUN_VIBE);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });

  expect(await ui.find({ type: "Text", text: /Please run: vibe trust/ })).toBeDefined();
});

test("the pane points at the install page when vibe cannot run", async ($, on) => {
  stubPane(on, { deny: "spawn vibe ENOENT" });

  await $.command.run(RUN_VIBE);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect(await ui.find({ type: "Text", text: /installation/ })).toBeDefined();
});

test("the pane draws in the Desktop app too", async ($, on) => {
  stubPane(on, ran(0, "", LISTING));

  await $.command.run(RUN_VIBE);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect(await ui.find({ key: "remove-/work/repo-feat-b" })).toBeDefined();
});
