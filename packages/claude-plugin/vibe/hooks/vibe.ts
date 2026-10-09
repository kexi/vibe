import type { ProcessRunResult } from "claude-code";

// How the hooks invoke vibe and read what it reports. Nothing here touches the
// mods API: Claude Code's validator follows `$` only into functions declared in
// the same file as the hook, so every `$.process.run` call stays at its hook and
// passes its promise to `settle` below.

/** `vibe --version`: run first, to learn whether vibe can start at all. */
export const VERSION_ARGV = ["vibe", "--version"] as const;

/** `vibe start` in Claude Code's WorktreeCreate protocol: stdin `{ name }`, stdout the bare path. */
export const START_HOOK_ARGV = ["vibe", "start", "--claude-code-worktree-hook"] as const;

/** `vibe clean` in Claude Code's WorktreeRemove protocol: stdin `{ worktree_path }`, no stdout. */
export const CLEAN_HOOK_ARGV = ["vibe", "clean", "--claude-code-worktree-hook"] as const;

export const VERSION_TIMEOUT_MS = 10_000;
// The same budgets the settings-hook setup in the docs gives these commands:
// a start can copy a large tree and run the repository's post_start hooks.
export const START_TIMEOUT_MS = 300_000;
export const CLEAN_TIMEOUT_MS = 120_000;

/**
 * The stderr line `vibe start` prints when a pre_start hook failed. The
 * worktree still exists and its path is still printed, but the copy and the
 * post_start hooks were skipped.
 */
export const PRE_START_GATED_SIGNAL = "vibe: pre_start hook failed; worktree is not provisioned";

// vibe's messages for a .vibe.toml (or .vibe.local.toml) the user has not
// approved, from rust/crates/vibe-core/src/config_loader.rs.
const UNTRUSTED_CONFIG_SIGNALS = [
  "is not trusted or has been modified",
  "trusted under older configuration semantics",
];

// Why a fixed text rather than vibe's own: vibe ends with "Please run: vibe
// trust", which is advice for a person. Handed to Claude as a failure reason it
// reads as an instruction, and an agent that approves the config itself would
// let the repository's hooks run without the person ever reviewing them.
export const UNTRUSTED_CONFIG_REASON =
  "vibe did not run because this repository's vibe config is not trusted. " +
  "The user has to review it and run `vibe trust` themselves; do not run it for them.";

// A failure reason goes to Claude as text; keep it to one readable line.
const MAX_REASON_LENGTH = 500;

/** What running vibe came to: it ran (any exit code), or it never got to run. */
export type VibeOutcome =
  | { kind: "ran"; exitCode: number; stdout: string; stderr: string }
  | { kind: "unavailable"; reason: string };

/**
 * Turns a `$.process.run` promise into a VibeOutcome. The call rejects when the
 * program cannot start or is still running at the timeout; which of the two it
 * was is for the caller to tell (see `isVibe`), not this function.
 */
export async function settle(run: Promise<ProcessRunResult>): Promise<VibeOutcome> {
  try {
    const { exitCode, stdout, stderr } = await run;
    return { kind: "ran", exitCode, stdout, stderr };
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Whether `vibe --version` ran and printed vibe's own banner. The hooks check
 * this before the real command, so that falling back to Claude Code's git
 * behavior happens only when vibe could not start, never after a vibe run
 * that timed out with a worktree half made. The banner check also keeps an
 * unrelated program named `vibe` earlier on PATH from being handed the event.
 */
export function isVibe(probe: VibeOutcome): boolean {
  return probe.kind === "ran" && probe.exitCode === 0 && probe.stdout.startsWith("vibe ");
}

/** Why a probe failed, for the notice the hooks show. */
export function probeFailure(probe: VibeOutcome): string {
  if (probe.kind === "unavailable") return probe.reason;
  return `\`vibe --version\` exited ${probe.exitCode} without vibe's banner`;
}

const sanitize = (text: string): string =>
  // Control characters (ANSI color codes among them) would reach Claude as noise.
  // oxlint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_REASON_LENGTH);

/**
 * The reason to give Claude when vibe ran and failed: a fixed text for an
 * untrusted config, otherwise vibe's `Error:` line, otherwise its last line.
 */
export function failureReason(stderr: string, fallback: string): string {
  const isUntrustedConfig = UNTRUSTED_CONFIG_SIGNALS.some((signal) => stderr.includes(signal));
  if (isUntrustedConfig) return UNTRUSTED_CONFIG_REASON;

  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const errorLine = lines.findLast((line) => line.startsWith("Error:"));
  return sanitize(errorLine ?? lines.at(-1) ?? fallback);
}

// vibe prints an absolute path on one line (Outcome::stdout_path refuses a
// newline); anything else is not a path to hand Claude Code.
const isAbsolutePath = (text: string): boolean =>
  !text.includes("\n") && (text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text));

/** What the WorktreeCreate hook does with a `vibe start` outcome. */
export type CreateDecision =
  | { kind: "created"; worktreePath: string; isProvisioned: boolean }
  | { kind: "failed"; reason: string };

export function decideCreate(outcome: VibeOutcome): CreateDecision {
  // vibe answered `--version` a moment ago, so a rejection here means vibe
  // start was killed at its timeout, after it may already have made the
  // worktree. Falling back would make a second one; refuse instead.
  if (outcome.kind === "unavailable") {
    return {
      kind: "failed",
      reason: sanitize(
        "vibe start did not finish (" + outcome.reason + "); the worktree may be partly created",
      ),
    };
  }

  const worktreePath = outcome.stdout.trim();
  const isSuccess = outcome.exitCode === 0 && isAbsolutePath(worktreePath);
  if (!isSuccess) {
    const fallback = `vibe start failed (exit ${outcome.exitCode})`;
    return { kind: "failed", reason: failureReason(outcome.stderr, fallback) };
  }

  const isProvisioned = !outcome.stderr.includes(PRE_START_GATED_SIGNAL);
  return { kind: "created", worktreePath, isProvisioned };
}

/** What the WorktreeRemove hook does with a `vibe clean` outcome. */
export type RemoveDecision = { kind: "removed" } | { kind: "failed"; reason: string };

export function decideRemove(outcome: VibeOutcome): RemoveDecision {
  if (outcome.kind === "unavailable") {
    return {
      kind: "failed",
      reason: sanitize("vibe clean did not finish (" + outcome.reason + ")"),
    };
  }

  const isSuccess = outcome.exitCode === 0;
  if (!isSuccess) {
    const fallback = `vibe clean failed (exit ${outcome.exitCode})`;
    return { kind: "failed", reason: failureReason(outcome.stderr, fallback) };
  }
  return { kind: "removed" };
}
