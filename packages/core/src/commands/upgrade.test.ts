import { describe, it, expect } from "vitest";
import { compareVersions, parseVersion } from "./upgrade.ts";

describe("parseVersion", () => {
  it("parses standard semver correctly", () => {
    const result = parseVersion("1.2.3");
    expect(result).toEqual([1, 2, 3]);
  });

  it("pads missing minor and patch with zeros", () => {
    const result = parseVersion("1");
    expect(result).toEqual([1, 0, 0]);
  });

  it("pads missing patch with zero", () => {
    const result = parseVersion("1.0");
    expect(result).toEqual([1, 0, 0]);
  });

  it("strips build metadata", () => {
    const result = parseVersion("1.2.3+abc");
    expect(result).toEqual([1, 2, 3]);
  });

  it("strips complex build metadata", () => {
    const result = parseVersion("1.2.3+build.123.abc");
    expect(result).toEqual([1, 2, 3]);
  });

  it("throws for invalid version format", () => {
    expect(() => parseVersion("invalid")).toThrow("Invalid version format: invalid");
  });

  it("throws for empty string", () => {
    expect(() => parseVersion("")).toThrow("Invalid version format: ");
  });

  it("throws for non-numeric parts", () => {
    expect(() => parseVersion("1.x.3")).toThrow("Invalid version format: 1.x.3");
  });

  it("handles zero versions", () => {
    const result = parseVersion("0.0.0");
    expect(result).toEqual([0, 0, 0]);
  });

  it("handles large version numbers", () => {
    const result = parseVersion("100.200.300");
    expect(result).toEqual([100, 200, 300]);
  });
});

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    const result = compareVersions("1.0.0", "1.0.0");
    expect(result).toBe(0);
  });

  it("returns negative when a < b (major)", () => {
    const result = compareVersions("1.0.0", "2.0.0");
    expect(result < 0).toBe(true);
  });

  it("returns positive when a > b (major)", () => {
    const result = compareVersions("2.0.0", "1.0.0");
    expect(result > 0).toBe(true);
  });

  it("returns negative when a < b (minor)", () => {
    const result = compareVersions("1.0.0", "1.1.0");
    expect(result < 0).toBe(true);
  });

  it("returns positive when a > b (minor)", () => {
    const result = compareVersions("1.1.0", "1.0.0");
    expect(result > 0).toBe(true);
  });

  it("returns negative when a < b (patch)", () => {
    const result = compareVersions("1.0.0", "1.0.1");
    expect(result < 0).toBe(true);
  });

  it("returns positive when a > b (patch)", () => {
    const result = compareVersions("1.0.1", "1.0.0");
    expect(result > 0).toBe(true);
  });

  it("handles version with build metadata", () => {
    const result = compareVersions("1.2.3+abc", "1.2.3+def");
    expect(result).toBe(0); // Build metadata should be ignored
  });

  it("compares 0.10.0 > 0.9.0 correctly", () => {
    const result = compareVersions("0.10.0", "0.9.0");
    expect(result > 0).toBe(true);
  });

  it("compares 0.9.0 < 0.10.0 correctly", () => {
    const result = compareVersions("0.9.0", "0.10.0");
    expect(result < 0).toBe(true);
  });

  it("handles padded versions correctly", () => {
    const result = compareVersions("1.0", "1.0.0");
    expect(result).toBe(0);
  });

  it("handles single-part versions", () => {
    const result = compareVersions("1", "1.0.0");
    expect(result).toBe(0);
  });
});
