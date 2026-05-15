import { describe, it, expect } from "vitest";
import { parseArgsOptions } from "../../../../main.ts";
import { SUBCOMMANDS, GLOBAL_FLAGS } from "./fish-completion.ts";

// Internal flags intentionally excluded from fish completion. Add new entries here
// when introducing internal-only flags that should not surface in user-facing completion.
const INTERNAL_FLAGS_NOT_EXPOSED_TO_COMPLETION = new Set(["claude-code-worktree-hook"]);

describe("CLI flag metadata consistency", () => {
  const parseArgsKeys = new Set(Object.keys(parseArgsOptions ?? {}));
  const completionFlagSet = new Set<string>([
    ...GLOBAL_FLAGS.map((f) => f.long),
    ...SUBCOMMANDS.flatMap((c) => c.flags?.map((f) => f.long) ?? []),
  ]);

  it("every parseArgs flag is either in fish completion or explicitly internal", () => {
    const missing = [...parseArgsKeys].filter(
      (k) => !completionFlagSet.has(k) && !INTERNAL_FLAGS_NOT_EXPOSED_TO_COMPLETION.has(k),
    );
    expect(missing).toEqual([]);
  });

  it("every fish completion flag is defined in parseArgs", () => {
    const orphan = [...completionFlagSet].filter((k) => !parseArgsKeys.has(k));
    expect(orphan).toEqual([]);
  });

  it("internal allowlist has no dead entries", () => {
    const dead = [...INTERNAL_FLAGS_NOT_EXPOSED_TO_COMPLETION].filter((k) => !parseArgsKeys.has(k));
    expect(dead).toEqual([]);
  });

  it("short flag aliases agree between parseArgs and fish completion", () => {
    const completionShorts = new Map<string, string>();
    for (const f of GLOBAL_FLAGS) {
      if (f.short) completionShorts.set(f.long, f.short);
    }
    for (const c of SUBCOMMANDS) {
      for (const f of c.flags ?? []) {
        if (f.short) completionShorts.set(f.long, f.short);
      }
    }

    for (const [long, short] of completionShorts) {
      const parseArgsEntry = parseArgsOptions?.[long];
      expect(parseArgsEntry?.short, `${long} short mismatch`).toBe(short);
    }
  });

  it("every parseArgs short alias is also declared in fish completion", () => {
    const completionShorts = new Set<string>();
    for (const f of GLOBAL_FLAGS) {
      if (f.short) completionShorts.add(f.long);
    }
    for (const c of SUBCOMMANDS) {
      for (const f of c.flags ?? []) {
        if (f.short) completionShorts.add(f.long);
      }
    }

    const missingShorts: string[] = [];
    for (const [long, def] of Object.entries(parseArgsOptions ?? {})) {
      const isInternal = INTERNAL_FLAGS_NOT_EXPOSED_TO_COMPLETION.has(long);
      const hasShort = def?.short !== undefined;
      if (hasShort && !isInternal && !completionShorts.has(long)) {
        missingShorts.push(long);
      }
    }
    expect(missingShorts).toEqual([]);
  });

  it("takesValue flags map to parseArgs type=string", () => {
    const valueFlags = [...GLOBAL_FLAGS, ...SUBCOMMANDS.flatMap((c) => c.flags ?? [])].filter(
      (f) => f.takesValue,
    );
    for (const f of valueFlags) {
      expect(parseArgsOptions?.[f.long]?.type, `${f.long} type`).toBe("string");
    }
  });
});
