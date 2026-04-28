import { describe, it, expect } from "vitest";
import { validateWorktreePath } from "./worktree-path-validation.ts";

describe("validateWorktreePath", () => {
  describe("accepts clean absolute paths", () => {
    it("returns canonical form for a clean POSIX absolute path", () => {
      const result = validateWorktreePath("/tmp/foo/bar");
      expect(result).toBe("/tmp/foo/bar");
    });

    it("normalizes redundant separators", () => {
      const result = validateWorktreePath("/tmp//foo");
      expect(result).toBe("/tmp/foo");
    });

    it("normalizes single-dot segments", () => {
      const result = validateWorktreePath("/tmp/./foo");
      expect(result).toBe("/tmp/foo");
    });

    it("accepts root /", () => {
      const result = validateWorktreePath("/");
      expect(result).toBe("/");
    });

    it("accepts paths with '..' inside a filename (not a segment)", () => {
      expect(validateWorktreePath("/tmp/foo..bar/x")).toBe("/tmp/foo..bar/x");
      expect(validateWorktreePath("/tmp/..foo/x")).toBe("/tmp/..foo/x");
      expect(validateWorktreePath("/tmp/foo../x")).toBe("/tmp/foo../x");
    });
  });

  describe("rejects relative or empty paths", () => {
    it("rejects empty string", () => {
      expect(() => validateWorktreePath("")).toThrow();
    });

    it("rejects whitespace-only string", () => {
      expect(() => validateWorktreePath("   ")).toThrow(/empty/);
    });

    it("rejects relative path './foo'", () => {
      expect(() => validateWorktreePath("./foo")).toThrow(/absolute/);
    });

    it("rejects bare '.'", () => {
      expect(() => validateWorktreePath(".")).toThrow(/absolute/);
    });

    it("rejects bare '..'", () => {
      expect(() => validateWorktreePath("..")).toThrow();
    });
  });

  describe("rejects argument-injection attempts", () => {
    it("rejects leading '-' like '-rf'", () => {
      expect(() => validateWorktreePath("-rf")).toThrow(/must not start with '-'/);
    });

    it("rejects leading '--exec=evil'", () => {
      expect(() => validateWorktreePath("--exec=evil")).toThrow(/must not start with '-'/);
    });
  });

  describe("rejects '..' segments", () => {
    it("rejects '/tmp/../etc'", () => {
      expect(() => validateWorktreePath("/tmp/../etc")).toThrow(/'\.\.'/);
    });

    it("rejects '/tmp/foo/../bar'", () => {
      expect(() => validateWorktreePath("/tmp/foo/../bar")).toThrow(/'\.\.'/);
    });

    it("rejects backslash-separated '..' segments", () => {
      expect(() => validateWorktreePath("C:\\tmp\\..\\Windows")).toThrow();
    });
  });

  describe("rejects control characters", () => {
    it("rejects null bytes (delegated to validatePath)", () => {
      expect(() => validateWorktreePath("/tmp/foo\x00bar")).toThrow(/null byte/);
    });

    it("rejects newlines (delegated to validatePath)", () => {
      expect(() => validateWorktreePath("/tmp/foo\nbar")).toThrow(/newline/);
    });

    it("rejects ESC (0x1b) for ANSI escape injection defense", () => {
      expect(() => validateWorktreePath("/tmp/foo\x1b[2J")).toThrow();
    });

    it("rejects DEL (0x7f)", () => {
      expect(() => validateWorktreePath("/tmp/foo\x7f")).toThrow(/control characters/);
    });
  });

  describe("rejects Windows-specific path forms", () => {
    it("rejects drive-relative 'C:foo'", () => {
      expect(() => validateWorktreePath("C:foo")).toThrow(/drive-relative/);
    });

    it("rejects Windows long-path prefix '\\\\?\\C:\\foo'", () => {
      expect(() => validateWorktreePath("\\\\?\\C:\\foo")).toThrow(/long-path or UNC/);
    });

    it("rejects UNC prefix '\\\\server\\share'", () => {
      expect(() => validateWorktreePath("\\\\server\\share")).toThrow(/long-path or UNC/);
    });
  });

  describe("rejects shell injection patterns", () => {
    it("rejects command substitution '$(rm -rf)'", () => {
      expect(() => validateWorktreePath("/tmp/$(rm -rf)")).toThrow(/command substitution/);
    });

    it("rejects backticks", () => {
      expect(() => validateWorktreePath("/tmp/`whoami`")).toThrow(/command substitution/);
    });
  });

  describe("error messages do not leak control characters", () => {
    it("escapes control chars in the echoed path", () => {
      try {
        validateWorktreePath("/tmp/foo\x1b[2Jbar");
        throw new Error("should have thrown");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-control-regex
        expect(message).not.toMatch(/[\x00-\x1f\x7f]/);
        expect(message).toContain("\\x1b");
      }
    });

    it("escapes DEL in the echoed path", () => {
      try {
        validateWorktreePath("/tmp/foo\x7f");
        throw new Error("should have thrown");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-control-regex
        expect(message).not.toMatch(/[\x00-\x1f\x7f]/);
        expect(message).toContain("\\x7f");
      }
    });
  });
});
