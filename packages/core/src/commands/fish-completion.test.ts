import { describe, it, expect } from "vitest";
import { generateFishCompletion } from "./fish-completion.ts";

describe("generateFishCompletion", () => {
  const script = generateFishCompletion();

  it("disables file completion globally", () => {
    expect(script).toContain("complete -c vibe -f");
  });

  it("registers every subcommand under __fish_use_subcommand", () => {
    const subcommands = [
      "start",
      "scratch",
      "jump",
      "rename",
      "clean",
      "home",
      "trust",
      "untrust",
      "verify",
      "config",
      "upgrade",
      "shell-setup",
    ];
    for (const name of subcommands) {
      expect(script).toContain(`-n __fish_use_subcommand -a ${name}`);
    }
  });

  it("emits dynamic branch completion for `vibe start`", () => {
    expect(script).toContain("__fish_seen_subcommand_from start");
    expect(script).toContain(
      "git for-each-ref --format='%(refname:short)' refs/heads refs/remotes",
    );
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
