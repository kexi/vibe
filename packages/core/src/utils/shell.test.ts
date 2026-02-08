import { describe, expect, it } from "vitest";
import { escapeShellPath } from "./shell.ts";

describe("escapeShellPath", () => {
  it("returns the path unchanged when no single quotes are present", () => {
    expect(escapeShellPath("/home/user/project")).toBe("/home/user/project");
  });

  it("escapes a single quote in the path", () => {
    expect(escapeShellPath("/home/user/it's-a-path")).toBe("/home/user/it'\\''s-a-path");
  });

  it("escapes multiple single quotes", () => {
    expect(escapeShellPath("a'b'c")).toBe("a'\\''b'\\''c");
  });

  it("handles an empty string", () => {
    expect(escapeShellPath("")).toBe("");
  });

  it("handles a path that is just a single quote", () => {
    expect(escapeShellPath("'")).toBe("'\\''");
  });

  it("handles consecutive single quotes", () => {
    expect(escapeShellPath("''")).toBe("'\\'''\\''");
  });

  it("does not alter double quotes or other special characters", () => {
    expect(escapeShellPath('/path/with "double" and $var')).toBe('/path/with "double" and $var');
  });
});
