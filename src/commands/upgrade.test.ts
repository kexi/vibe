import { assertEquals, assertThrows } from "@std/assert";
import { compareVersions, parseVersion } from "./upgrade.ts";

// parseVersion tests

Deno.test("parseVersion parses standard semver correctly", () => {
  const result = parseVersion("1.2.3");
  assertEquals(result, [1, 2, 3]);
});

Deno.test("parseVersion pads missing minor and patch with zeros", () => {
  const result = parseVersion("1");
  assertEquals(result, [1, 0, 0]);
});

Deno.test("parseVersion pads missing patch with zero", () => {
  const result = parseVersion("1.0");
  assertEquals(result, [1, 0, 0]);
});

Deno.test("parseVersion strips build metadata", () => {
  const result = parseVersion("1.2.3+abc");
  assertEquals(result, [1, 2, 3]);
});

Deno.test("parseVersion strips complex build metadata", () => {
  const result = parseVersion("1.2.3+build.123.abc");
  assertEquals(result, [1, 2, 3]);
});

Deno.test("parseVersion throws for invalid version format", () => {
  assertThrows(
    () => parseVersion("invalid"),
    Error,
    "Invalid version format: invalid",
  );
});

Deno.test("parseVersion throws for empty string", () => {
  assertThrows(
    () => parseVersion(""),
    Error,
    "Invalid version format: ",
  );
});

Deno.test("parseVersion throws for non-numeric parts", () => {
  assertThrows(
    () => parseVersion("1.x.3"),
    Error,
    "Invalid version format: 1.x.3",
  );
});

Deno.test("parseVersion handles zero versions", () => {
  const result = parseVersion("0.0.0");
  assertEquals(result, [0, 0, 0]);
});

Deno.test("parseVersion handles large version numbers", () => {
  const result = parseVersion("100.200.300");
  assertEquals(result, [100, 200, 300]);
});

// compareVersions tests

Deno.test("compareVersions returns 0 for equal versions", () => {
  const result = compareVersions("1.0.0", "1.0.0");
  assertEquals(result, 0);
});

Deno.test("compareVersions returns negative when a < b (major)", () => {
  const result = compareVersions("1.0.0", "2.0.0");
  assertEquals(result < 0, true);
});

Deno.test("compareVersions returns positive when a > b (major)", () => {
  const result = compareVersions("2.0.0", "1.0.0");
  assertEquals(result > 0, true);
});

Deno.test("compareVersions returns negative when a < b (minor)", () => {
  const result = compareVersions("1.0.0", "1.1.0");
  assertEquals(result < 0, true);
});

Deno.test("compareVersions returns positive when a > b (minor)", () => {
  const result = compareVersions("1.1.0", "1.0.0");
  assertEquals(result > 0, true);
});

Deno.test("compareVersions returns negative when a < b (patch)", () => {
  const result = compareVersions("1.0.0", "1.0.1");
  assertEquals(result < 0, true);
});

Deno.test("compareVersions returns positive when a > b (patch)", () => {
  const result = compareVersions("1.0.1", "1.0.0");
  assertEquals(result > 0, true);
});

Deno.test("compareVersions handles version with build metadata", () => {
  const result = compareVersions("1.2.3+abc", "1.2.3+def");
  assertEquals(result, 0); // Build metadata should be ignored
});

Deno.test("compareVersions compares 0.10.0 > 0.9.0 correctly", () => {
  const result = compareVersions("0.10.0", "0.9.0");
  assertEquals(result > 0, true);
});

Deno.test("compareVersions compares 0.9.0 < 0.10.0 correctly", () => {
  const result = compareVersions("0.9.0", "0.10.0");
  assertEquals(result < 0, true);
});

Deno.test("compareVersions handles padded versions correctly", () => {
  const result = compareVersions("1.0", "1.0.0");
  assertEquals(result, 0);
});

Deno.test("compareVersions handles single-part versions", () => {
  const result = compareVersions("1", "1.0.0");
  assertEquals(result, 0);
});
