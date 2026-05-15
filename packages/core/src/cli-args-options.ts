import type { ParseArgsConfig } from "node:util";

/**
 * CLI options configuration for node:util parseArgs.
 *
 * Shared between the CLI entrypoint (main.ts) and the flag-consistency test
 * that cross-checks this table against the fish completion metadata.
 */
export const parseArgsOptions: ParseArgsConfig["options"] = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  verbose: { type: "boolean", short: "V" },
  quiet: { type: "boolean", short: "q" },
  reuse: { type: "boolean" },
  "no-hooks": { type: "boolean" },
  "no-copy": { type: "boolean" },
  "dry-run": { type: "boolean", short: "n" },
  force: { type: "boolean", short: "f" },
  "delete-branch": { type: "boolean" },
  "keep-branch": { type: "boolean" },
  check: { type: "boolean" },
  base: { type: "string" },
  track: { type: "boolean" },
  shell: { type: "string" },
  "with-completion": { type: "boolean" },
  "claude-code-worktree-hook": { type: "boolean" },
};
