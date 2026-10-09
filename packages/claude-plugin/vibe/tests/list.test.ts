import { describe, expect, test } from "claude-code/testing";

import {
  type Worktree,
  describeListFailure,
  formatAge,
  formatRows,
  formatStatus,
  parseVibeList,
  removalQuestion,
} from "../hooks/list";

const NOW = Date.parse("2026-10-10T12:00:00Z");

const worktree = (overrides: Partial<Worktree>): Worktree => ({
  branch: "feat/login",
  path: "/work/repo-feat-login",
  isCurrent: false,
  isScratch: false,
  base: "main",
  lastCommitAt: "2026-10-10T10:00:00Z",
  status: "clean",
  dirtyFiles: 0,
  ...overrides,
});

describe("parseVibeList", () => {
  test("reads vibe list --json rows and maps their fields", () => {
    const stderr = JSON.stringify(
      [
        {
          branch: "main",
          path: "/work/repo",
          current: true,
          scratch: false,
          name: "repo",
          base: null,
          head: "abc",
          last_commit_at: "2026-10-10T10:00:00Z",
          status: "dirty",
          dirty_files: 3,
        },
      ],
      null,
      2,
    );

    expect(parseVibeList(stderr)).toEqual([
      {
        branch: "main",
        path: "/work/repo",
        isCurrent: true,
        isScratch: false,
        base: null,
        lastCommitAt: "2026-10-10T10:00:00Z",
        status: "dirty",
        dirtyFiles: 3,
      },
    ]);
  });

  test("skips a warning line vibe prints ahead of the array", () => {
    const stderr =
      'Warning: --verbose and --quiet conflict\n[\n  { "path": "/work/repo", "branch": null }\n]\n';

    const listing = parseVibeList(stderr);

    expect(listing?.length).toBe(1);
    expect(listing?.[0]?.branch).toBe(null);
  });

  test("keeps working when a newer vibe adds fields", () => {
    const stderr =
      '[{ "path": "/work/repo", "branch": "main", "summary": "x", "future_field": 1 }]';

    expect(parseVibeList(stderr)?.[0]?.path).toBe("/work/repo");
  });

  test("returns null when there is no array to read", () => {
    expect(parseVibeList("")).toBe(null);
    expect(parseVibeList("[not json")).toBe(null);
  });
});

describe("describeListFailure", () => {
  test("points at the install page when vibe cannot run", () => {
    expect(describeListFailure({ kind: "unavailable", reason: "ENOENT" })).toMatch(/installation/);
  });

  test("shows vibe's own last lines, which say what to do", () => {
    const stderr =
      "/work/repo/.vibe.toml: .vibe.toml file is not trusted or has been modified.\nPlease run: vibe trust\n";

    expect(describeListFailure({ kind: "ran", exitCode: 1, stdout: "", stderr })).toBe(
      "/work/repo/.vibe.toml: .vibe.toml file is not trusted or has been modified.\nPlease run: vibe trust",
    );
  });
});

describe("formatAge", () => {
  test("matches vibe list's AGE column, truncating", () => {
    expect(formatAge("2026-10-10T11:59:30Z", NOW)).toBe("now");
    expect(formatAge("2026-10-10T11:48:00Z", NOW)).toBe("12m");
    expect(formatAge("2026-10-10T10:00:00Z", NOW)).toBe("2h");
    expect(formatAge("2026-10-08T13:00:00Z", NOW)).toBe("1d");
    expect(formatAge("2026-09-30T12:00:00Z", NOW)).toBe("1w");
    expect(formatAge("2026-05-10T12:00:00Z", NOW)).toBe("5mo");
    expect(formatAge("2024-10-10T12:00:00Z", NOW)).toBe("2y");
  });

  test("reads a future commit as now and a missing one as -", () => {
    expect(formatAge("2026-10-11T12:00:00Z", NOW)).toBe("now");
    expect(formatAge(null, NOW)).toBe("-");
  });
});

describe("formatStatus and formatRows", () => {
  test("shows clean, M <n>, or - like vibe list", () => {
    expect(formatStatus(worktree({ status: "clean" }))).toBe("clean");
    expect(formatStatus(worktree({ status: "dirty", dirtyFiles: 3 }))).toBe("M 3");
    expect(formatStatus(worktree({ status: null }))).toBe("-");
  });

  test("pads every column so the rows line up", () => {
    const rows = formatRows(
      [worktree({ branch: "main", isCurrent: true, base: null }), worktree({ branch: null })],
      NOW,
    );

    expect(rows).toEqual(["*  main        -     2h  clean", "   (detached)  main  2h  clean"]);
  });
});

describe("removalQuestion", () => {
  test("warns about the uncommitted changes a removal discards", () => {
    expect(removalQuestion(worktree({ status: "dirty", dirtyFiles: 2 }))).toBe(
      "Remove the worktree feat/login (/work/repo-feat-login)? Its 2 uncommitted change(s) will be lost.",
    );
    expect(removalQuestion(worktree({}))).toBe(
      "Remove the worktree feat/login (/work/repo-feat-login)?",
    );
  });
});
