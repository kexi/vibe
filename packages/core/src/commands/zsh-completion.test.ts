import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateZshCompletion } from "./zsh-completion.ts";
import { SUBCOMMANDS } from "./completion-spec.ts";

describe("generateZshCompletion", () => {
  const script = generateZshCompletion();

  it("starts with #compdef vibe directive", () => {
    const firstNonEmpty = script.split("\n").find((line) => line.trim().length > 0);
    expect(firstNonEmpty).toBe("#compdef vibe");
  });

  it("registers every subcommand inside _vibe_commands", () => {
    for (const cmd of SUBCOMMANDS) {
      expect(script).toContain(`'${cmd.name}:`);
    }
  });

  it("emits _vibe_branches as positional action for start and scratch", () => {
    const startBlock = script.match(/_vibe_start\(\) \{[\s\S]*?\n\}/);
    const scratchBlock = script.match(/_vibe_scratch\(\) \{[\s\S]*?\n\}/);
    expect(startBlock?.[0]).toContain("'1: :_vibe_branches'");
    expect(scratchBlock?.[0]).toContain("'1: :_vibe_branches'");
  });

  it("emits _vibe_worktree_branches as positional action for jump", () => {
    const jumpBlock = script.match(/_vibe_jump\(\) \{[\s\S]*?\n\}/);
    expect(jumpBlock?.[0]).toContain("'1: :_vibe_worktree_branches'");
  });

  it("does not emit dynamic positional completion for rename", () => {
    const renameBlock = script.match(/_vibe_rename\(\) \{[\s\S]*?\n\}/);
    const hasBranchCompletion = renameBlock?.[0].includes("_vibe_branches") ?? false;
    const hasWorktreeBranchCompletion =
      renameBlock?.[0].includes("_vibe_worktree_branches") ?? false;
    expect(hasBranchCompletion).toBe(false);
    expect(hasWorktreeBranchCompletion).toBe(false);
  });

  it("_vibe_branches uses git for-each-ref refs/heads (no refs/remotes)", () => {
    expect(script).toContain("git for-each-ref --format='%(refname:short)' refs/heads");
    expect(script).not.toContain("refs/remotes");
  });

  it("_vibe_worktree_branches parses git worktree list --porcelain via awk", () => {
    expect(script).toContain("git worktree list --porcelain");
    expect(script).toContain("awk");
    expect(script).toContain("refs\\/heads");
  });

  it("marks --base and --shell as value-taking with = suffix", () => {
    expect(script).toMatch(/--base=\[/);
    expect(script).toMatch(/--shell=\[/);
  });

  it("offers shell name candidates for --shell", () => {
    expect(script).toContain("(bash zsh fish nushell powershell)");
  });

  it("groups short/long aliases mutually-exclusively", () => {
    expect(script).toContain("'(-h --help)'{-h,--help}");
    expect(script).toContain("'(-n --dry-run)'{-n,--dry-run}");
  });

  it("registers global flags at the top-level _arguments call", () => {
    const topLevelMatch = script.match(/_arguments -C \\([\s\S]*?)'1: :_vibe_commands'/);
    const topLevelBlock = topLevelMatch?.[1] ?? "";
    expect(topLevelBlock).toContain("--help");
    expect(topLevelBlock).toContain("--version");
    expect(topLevelBlock).toContain("--verbose");
    expect(topLevelBlock).toContain("--quiet");
  });

  it("does not include internal --claude-code-worktree-hook flag", () => {
    expect(script).not.toContain("claude-code-worktree-hook");
  });

  it("escapes apostrophes in descriptions using zsh '\\'' idiom", () => {
    // rename description contains `worktree's` — must be emitted as `worktree'\''s`
    expect(script).toContain("worktree'\\''s");
  });

  it("appends a guarded compdef _vibe vibe registration at the end", () => {
    expect(script).toContain("if (( ${+functions[compdef]} )); then");
    expect(script).toContain("  compdef _vibe vibe");
    expect(script.trimEnd().endsWith("fi")).toBe(true);
  });

  it("function name for shell-setup subcommand uses underscore", () => {
    expect(script).toContain("_vibe_shell_setup()");
    expect(script).not.toContain("_vibe_shell-setup()");
  });

  it("uses compadd -a for branch arrays", () => {
    const matches = script.match(/compadd -a branches/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("matches the snapshot", () => {
    expect(script).toMatchSnapshot();
  });
});

/**
 * Detect whether the `zsh` binary is available on PATH and can be invoked.
 * Returns true only when `zsh --version` exits cleanly.
 */
function isZshAvailable(): boolean {
  const isSkipped = process.env.SKIP_ZSH_TESTS === "1";
  if (isSkipped) return false;
  try {
    const result = spawnSync("zsh", ["--version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

// This suite is skipped when zsh is not on PATH. Set SKIP_ZSH_TESTS=1 to skip locally.
describe("generateZshCompletion (zsh parser integration)", () => {
  const zshAvailable = isZshAvailable();
  const maybe = zshAvailable ? it : it.skip;

  maybe("produces a script that passes `zsh -n` syntax check", () => {
    const script = generateZshCompletion();
    const tempDir = mkdtempSync(join(tmpdir(), "vibe-zsh-completion-"));
    const scriptPath = join(tempDir, "vibe.zsh");
    try {
      writeFileSync(scriptPath, script, "utf8");
      const result = spawnSync("zsh", ["-n", scriptPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stderr = result.stderr ?? "";
      const stdout = result.stdout ?? "";
      const hasFailed = result.status !== 0;
      if (hasFailed) {
        // Surface parser diagnostics in the test failure for fast triage.
        throw new Error(
          `zsh -n exited with status ${result.status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
      }
      expect(result.status).toBe(0);
      expect(stderr).toBe("");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
