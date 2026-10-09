#!/usr/bin/env bun

/**
 * Validate, test and (when possible) type-check the vibe Claude Code plugin in
 * packages/claude-plugin/vibe.
 *
 * Steps, in order, stopping at the first failure:
 *   1. `claude plugin validate --strict` on the plugin: the manifest plus the
 *      same static analysis Claude Code runs on the hooks module before it
 *      loads it (event names, `$` calls, imports).
 *   2. `claude plugin test` on the plugin: every `*.test.ts` under it, run in
 *      Claude Code's own test kit with no session, sign-in or network.
 *   3. `tsc -p` on the plugin, only when the mod API declarations exist.
 *
 * Why the CLI runs through cli-wrapper.cjs rather than `node_modules/.bin/claude`:
 * the package's bin is a stub until its postinstall copies the native binary
 * over it, and that postinstall never runs here (CI installs with
 * --ignore-scripts, and pnpm-workspace.yaml lists the package under
 * ignoredBuiltDependencies). The wrapper resolves the native optional
 * dependency for this platform itself.
 *
 * Why step 3 is skipped rather than failed when the declarations are missing:
 * Claude Code writes them (to the plugin's .claude-plugin/types/) only when it
 * loads the mod in a signed-in session, e.g. `claude --plugin-dir <plugin>`.
 * There is no way to produce them headlessly, so CI cannot type-check; the
 * validate and test steps are its gate, and a local run type-checks whenever a
 * session has written the declarations.
 *
 * Usage (from the repository root, as `just check-plugin` runs it):
 *   bun run scripts/claude-plugin-check.ts
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const PLUGIN_DIR = join(REPO_ROOT, "packages/claude-plugin/vibe");
const CLAUDE_CLI = join(REPO_ROOT, "node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs");
const TSC = join(REPO_ROOT, "node_modules/typescript/bin/tsc");
const MOD_API_DECLARATIONS = join(PLUGIN_DIR, ".claude-plugin/types/claude-code/index.d.ts");

/** One command of the check, run with argv (never a shell string). */
interface Step {
  name: string;
  argv: string[];
}

/** The steps to run, given whether the mod API declarations are present. */
function planSteps(hasDeclarations: boolean): Step[] {
  const steps: Step[] = [
    { name: "validate", argv: ["node", CLAUDE_CLI, "plugin", "validate", "--strict", PLUGIN_DIR] },
    { name: "test", argv: ["node", CLAUDE_CLI, "plugin", "test", PLUGIN_DIR] },
  ];
  if (hasDeclarations) {
    steps.push({ name: "typecheck", argv: ["node", TSC, "-p", PLUGIN_DIR] });
  }
  return steps;
}

function run(step: Step): Promise<number> {
  const [command, ...args] = step.argv;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const isCliInstalled = existsSync(CLAUDE_CLI);
  if (!isCliInstalled) {
    console.error(`✗ ${CLAUDE_CLI} is missing; run \`just install\` first.`);
    process.exit(1);
  }

  const hasDeclarations = existsSync(MOD_API_DECLARATIONS);
  for (const step of planSteps(hasDeclarations)) {
    const exitCode = await run(step);
    if (exitCode !== 0) {
      console.error(`✗ ${step.name} failed (exit ${exitCode}).`);
      process.exit(exitCode);
    }
    console.log(`✓ ${step.name} passed.`);
  }

  if (!hasDeclarations) {
    console.log(
      "- typecheck skipped: no mod API declarations yet. Load the plugin once with " +
        "`claude --plugin-dir packages/claude-plugin/vibe` to have Claude Code write them.",
    );
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`claude-plugin-check: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
