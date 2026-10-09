import type { VibeOutcome } from "./vibe";

// Reading `vibe list --json` for the /vibe pane. Pure: the pane's hooks run
// vibe and hand the outcome here.

/** `vibe list --json`: the worktree listing, written to stderr as a JSON array. */
export const LIST_ARGV = ["vibe", "list", "--json"] as const;

// `vibe list` may run the repository's `[summary]` command per worktree, which
// has its own 30 s default timeout; leave room for that on top of git.
export const LIST_TIMEOUT_MS = 45_000;

/** One worktree, as the pane draws it. */
export interface Worktree {
  branch: string | null;
  path: string;
  isCurrent: boolean;
  isScratch: boolean;
  base: string | null;
  lastCommitAt: string | null;
  status: "clean" | "dirty" | null;
  dirtyFiles: number | null;
}

const optionalString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

function toWorktree(value: unknown): Worktree | null {
  const isObject = typeof value === "object" && value !== null;
  if (!isObject) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.path !== "string") return null;

  const isKnownStatus = row.status === "clean" || row.status === "dirty";
  return {
    branch: optionalString(row.branch),
    path: row.path,
    isCurrent: row.current === true,
    isScratch: row.scratch === true,
    base: optionalString(row.base),
    lastCommitAt: optionalString(row.last_commit_at),
    status: isKnownStatus ? (row.status as "clean" | "dirty") : null,
    dirtyFiles: typeof row.dirty_files === "number" ? row.dirty_files : null,
  };
}

/**
 * Parses the JSON array `vibe list --json` writes to stderr. vibe can print a
 * warning line ahead of it, so parsing starts at the first line that opens the
 * array. Fields the pane does not draw are ignored, so a newer vibe that adds
 * fields keeps working. Returns null when there is no array to read.
 */
export function parseVibeList(stderr: string): Worktree[] | null {
  const lines = stderr.split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith("["));
  if (start === -1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(lines.slice(start).join("\n"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.map(toWorktree).filter((worktree): worktree is Worktree => worktree !== null);
}

/** What the pane shows when there is no listing to draw. */
export function describeListFailure(outcome: VibeOutcome): string {
  if (outcome.kind === "unavailable") {
    return "vibe could not run. Install it and make sure it is on PATH: https://vibe.kexi.dev/installation/";
  }
  // vibe's own messages already say what to do ("Please run: vibe trust",
  // "Not inside a git repository."), so show its last few lines as they are.
  const lines = outcome.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const tail = lines.slice(-3).join("\n");
  return tail || `vibe list failed (exit ${outcome.exitCode})`;
}

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * The AGE column of `vibe list`: `now`, `12m`, `2h`, `3d`, `1w`, `5mo`, `2y`.
 * Mirrors `format_age` in rust/crates/vibe-core/src/commands/list.rs, so the
 * pane and the terminal agree: truncated, never rounded up, and a commit dated
 * in the future reads `now`.
 */
export function formatAge(lastCommitAt: string | null, nowMs: number): string {
  if (lastCommitAt === null) return "-";
  const commitMs = Date.parse(lastCommitAt);
  if (Number.isNaN(commitMs)) return "-";

  const elapsed = Math.floor((nowMs - commitMs) / 1000);
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d`;
  if (elapsed < MONTH) return `${Math.floor(elapsed / WEEK)}w`;
  if (elapsed < YEAR) return `${Math.floor(elapsed / MONTH)}mo`;
  return `${Math.floor(elapsed / YEAR)}y`;
}

/** The STATUS column of `vibe list`: `clean`, `M <n>`, or `-` when unknown. */
export function formatStatus(worktree: Worktree): string {
  if (worktree.status === "clean") return "clean";
  if (worktree.status === "dirty") return `M ${worktree.dirtyFiles ?? "?"}`;
  return "-";
}

/** The BRANCH column of `vibe list`, with `(detached)` for a detached HEAD. */
export function formatBranch(worktree: Worktree): string {
  return worktree.branch ?? "(detached)";
}

/**
 * One line per worktree with vibe list's columns (marker, BRANCH, BASE, AGE,
 * STATUS), padded so they line up in a monospaced pane. The path is left out:
 * the pane draws it separately so it can truncate it to the pane's width.
 */
export function formatRows(worktrees: readonly Worktree[], nowMs: number): string[] {
  const cells = worktrees.map((worktree) => [
    worktree.isCurrent ? "*" : " ",
    formatBranch(worktree),
    worktree.base ?? "-",
    formatAge(worktree.lastCommitAt, nowMs),
    formatStatus(worktree),
  ]);
  const widths = cells.reduce<number[]>(
    (max, row) => row.map((cell, i) => Math.max(max[i] ?? 0, cell.length)),
    [],
  );
  return cells.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  "));
}

/** The question the pane asks before it removes a worktree. */
export function removalQuestion(worktree: Worktree): string {
  const target = `${formatBranch(worktree)} (${worktree.path})`;
  const isDirty = worktree.status === "dirty";
  if (!isDirty) return `Remove the worktree ${target}?`;
  const count = worktree.dirtyFiles ?? "some";
  return `Remove the worktree ${target}? Its ${count} uncommitted change(s) will be lost.`;
}
