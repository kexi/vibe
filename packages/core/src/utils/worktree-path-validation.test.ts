import { describe, it, expect } from "vitest";
import {
  assertNoControlChars,
  assertOutputHasNoControlChars,
  buildShellMetacharWarning,
  buildWarningKey,
  findShellMetachars,
} from "./worktree-path-validation.ts";

describe("assertNoControlChars", () => {
  it("accepts plain ASCII", () => {
    expect(() => assertNoControlChars("VIBE_BRANCH_NAME", "feat/test-branch")).not.toThrow();
  });

  it("accepts unicode without control chars", () => {
    expect(() => assertNoControlChars("VIBE_BRANCH_NAME", "feat/branch-name")).not.toThrow();
  });

  it("accepts shell metacharacters (those are warnings, not errors)", () => {
    expect(() => assertNoControlChars("VIBE_BRANCH_NAME", "feat/$evil")).not.toThrow();
  });

  it("accepts the empty string", () => {
    expect(() => assertNoControlChars("VIBE_BRANCH_NAME", "")).not.toThrow();
  });

  it("rejects newline (0x0a)", () => {
    expect(() => assertNoControlChars("VIBE_BRANCH_NAME", "feat\nrm -rf /")).toThrow(
      /VIBE_BRANCH_NAME contains a control character \(0x0a\)/,
    );
  });

  it("rejects NUL (0x00)", () => {
    expect(() => assertNoControlChars("VIBE_REPO_NAME", "evil\x00name")).toThrow(
      /VIBE_REPO_NAME contains a control character \(0x00\)/,
    );
  });

  it("rejects DEL (0x7f)", () => {
    expect(() => assertNoControlChars("VIBE_SANITIZED_BRANCH", "feat\x7f")).toThrow(/0x7f/);
  });

  it("rejects US (0x1f) at the upper boundary of the control range", () => {
    expect(() => assertNoControlChars("VIBE_BRANCH_NAME", "feat\x1fevil")).toThrow(
      /VIBE_BRANCH_NAME contains a control character \(0x1f\)/,
    );
  });

  it("accepts space (0x20) just above the control range", () => {
    expect(() => assertNoControlChars("VIBE_BRANCH_NAME", "feat test")).not.toThrow();
  });

  it("accepts tilde (0x7e) just below DEL (0x7f)", () => {
    expect(() => assertNoControlChars("VIBE_BRANCH_NAME", "feat~test")).not.toThrow();
  });

  it("includes a remediation hint in the message", () => {
    expect(() => assertNoControlChars("VIBE_BRANCH_NAME", "x\ny")).toThrow(/git branch -m/);
  });
});

describe("findShellMetachars", () => {
  it("returns empty array for clean values", () => {
    expect(findShellMetachars("feat-test-branch")).toEqual([]);
  });

  it("detects a single metacharacter", () => {
    expect(findShellMetachars("feat$evil")).toEqual(["$"]);
  });

  it("detects multiple distinct metacharacters in order", () => {
    expect(findShellMetachars("$foo;bar|baz")).toEqual(["$", ";", "|"]);
  });

  it("dedupes repeated metacharacters", () => {
    expect(findShellMetachars("$$$;;")).toEqual(["$", ";"]);
  });

  it("detects single quote as a metacharacter", () => {
    expect(findShellMetachars("foo'bar")).toEqual(["'"]);
  });

  it("detects backtick", () => {
    expect(findShellMetachars("foo`bar`")).toEqual(["`"]);
  });

  it("detects backslash and double-quote", () => {
    expect(findShellMetachars('a\\b"c')).toEqual(["\\", '"']);
  });
});

describe("buildWarningKey", () => {
  it("is stable regardless of metachar order", () => {
    const a = buildWarningKey("VIBE_BRANCH_NAME", ["$", ";"]);
    const b = buildWarningKey("VIBE_BRANCH_NAME", [";", "$"]);
    expect(a).toBe(b);
  });

  it("differs across fields", () => {
    const a = buildWarningKey("VIBE_BRANCH_NAME", ["$"]);
    const b = buildWarningKey("VIBE_REPO_NAME", ["$"]);
    expect(a).not.toBe(b);
  });
});

describe("buildShellMetacharWarning", () => {
  it("includes the field name and metachar list", () => {
    const msg = buildShellMetacharWarning("VIBE_BRANCH_NAME", ["$", "'"]);
    expect(msg).toContain("VIBE_BRANCH_NAME");
    expect(msg).toContain("$, '");
  });

  it("includes an actionable double-quote hint", () => {
    const msg = buildShellMetacharWarning("VIBE_BRANCH_NAME", ["$"]);
    expect(msg).toContain("double-quote");
  });

  it("warns about eval", () => {
    const msg = buildShellMetacharWarning("VIBE_BRANCH_NAME", ["$"]);
    expect(msg).toContain("eval");
  });
});

describe("assertOutputHasNoControlChars", () => {
  it("accepts an absolute path with no control chars", () => {
    expect(() => assertOutputHasNoControlChars("/home/user/worktrees/foo")).not.toThrow();
  });

  it("accepts a single trailing newline (echo's normal output)", () => {
    expect(() => assertOutputHasNoControlChars("/home/user/worktrees/foo\n")).not.toThrow();
  });

  it("accepts the empty string (caller validates emptiness separately)", () => {
    expect(() => assertOutputHasNoControlChars("")).not.toThrow();
  });

  it("rejects an embedded newline (multi-line output)", () => {
    expect(() => assertOutputHasNoControlChars("/home/user\nrm -rf /\n")).toThrow(
      /control character \(0x0a\)/,
    );
  });

  it("rejects multiple trailing newlines", () => {
    expect(() => assertOutputHasNoControlChars("/home/user\n\n")).toThrow(/0x0a/);
  });

  it("rejects carriage return", () => {
    expect(() => assertOutputHasNoControlChars("/home/user\r\n")).toThrow(/0x0d/);
  });

  it("rejects NUL", () => {
    expect(() => assertOutputHasNoControlChars("/home/user\x00evil")).toThrow(/0x00/);
  });

  it("rejects ANSI escape sequences (0x1b)", () => {
    expect(() => assertOutputHasNoControlChars("/home/user\x1b[31mred")).toThrow(/0x1b/);
  });

  it("rejects a leading newline even when there is also a single trailing newline", () => {
    // The trailing-newline allowance is for echo's normal terminator only; a
    // leading newline indicates an embedded control character that must be
    // rejected.
    expect(() => assertOutputHasNoControlChars("\n/home/user/worktrees/foo\n")).toThrow(
      /control character \(0x0a\)/,
    );
  });
});
