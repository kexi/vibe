import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFishCompletion } from "./fish-completion.ts";
import { SUBCOMMANDS } from "./completion-spec.ts";

describe("generateFishCompletion", () => {
  const script = generateFishCompletion();

  it("disables file completion globally", () => {
    expect(script).toContain("complete -c vibe -f");
  });

  it("registers every subcommand under __fish_use_subcommand", () => {
    for (const cmd of SUBCOMMANDS) {
      expect(script).toContain(`-n __fish_use_subcommand -a ${cmd.name}`);
    }
  });

  it("emits dynamic branch completion for `vibe start`", () => {
    expect(script).toContain("__fish_seen_subcommand_from start");
    expect(script).toContain("git for-each-ref --format='%(refname:short)' refs/heads");
    expect(script).not.toContain("refs/remotes");
  });

  it("emits worktree-only branch completion for `vibe jump`", () => {
    expect(script).toContain("__fish_seen_subcommand_from jump");
    expect(script).toContain("git worktree list --porcelain");
    expect(script).toContain("string match -rg '^branch refs/heads/(.+)'");
  });

  it("does not emit dynamic completion for `vibe rename`", () => {
    const renameDynamic = script.match(/__fish_seen_subcommand_from rename.*-a "\(git/);
    expect(renameDynamic).toBeNull();
  });

  it("does not emit dynamic positional completion for `vibe scratch`", () => {
    // scratch auto-generates a `scratch/<timestamp>` branch name — offering existing
    // branches as positional completion candidates would be misleading.
    const scratchDynamic = script.match(/__fish_seen_subcommand_from scratch.*-a "\(git/);
    expect(scratchDynamic).toBeNull();
  });

  it("marks --base and --shell as requiring an argument", () => {
    expect(script).toMatch(/__fish_seen_subcommand_from start.*-l base -r/);
    expect(script).toMatch(/__fish_seen_subcommand_from shell-setup.*-l shell -r/);
  });

  it("offers shell name candidates for --shell", () => {
    expect(script).toMatch(
      /__fish_seen_subcommand_from shell-setup.*-l shell .*-xa 'bash zsh fish nushell powershell'/,
    );
  });

  it("registers global flags without a subcommand condition", () => {
    expect(script).toMatch(/^complete -c vibe -s h -l help /m);
    expect(script).toMatch(/^complete -c vibe -s v -l version /m);
  });

  it("does not include internal --claude-code-worktree-hook flag", () => {
    expect(script).not.toContain("claude-code-worktree-hook");
  });

  it("escapes apostrophes in descriptions so fish single-quoted strings stay balanced", () => {
    // rename description contains `worktree's` — must be emitted as `worktree\'s`
    expect(script).toContain("worktree\\'s");
    expect(script).not.toMatch(/-d 'Rename the current worktree's/);
  });

  it("matches the snapshot", () => {
    expect(script).toMatchSnapshot();
  });
});

/**
 * Detect whether the `fish` binary is available on PATH and can be invoked.
 * Returns true only when `fish --version` exits cleanly.
 */
function isFishAvailable(): boolean {
  if (process.env.SKIP_FISH_TESTS === "1") return false;
  try {
    const result = spawnSync("fish", ["--version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

// This suite is skipped when fish is not on PATH (e.g. default GitHub-hosted runners).
// Local dev environments with fish installed run the parser check; CI with fish provisioned
// via mise would also run it. Set SKIP_FISH_TESTS=1 to skip locally.
describe("generateFishCompletion (fish parser integration)", () => {
  const fishAvailable = isFishAvailable();
  const maybe = fishAvailable ? it : it.skip;

  maybe("produces a script that passes `fish -n` syntax check", () => {
    const script = generateFishCompletion();
    const tempDir = mkdtempSync(join(tmpdir(), "vibe-fish-completion-"));
    const scriptPath = join(tempDir, "vibe.fish");
    try {
      writeFileSync(scriptPath, script, "utf8");
      const result = spawnSync("fish", ["-n", scriptPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stderr = result.stderr ?? "";
      const stdout = result.stdout ?? "";
      const failed = result.status !== 0;
      if (failed) {
        // Surface parser diagnostics in the test failure for fast triage.
        throw new Error(
          `fish -n exited with status ${result.status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
      }
      expect(result.status).toBe(0);
      expect(stderr).toBe("");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
