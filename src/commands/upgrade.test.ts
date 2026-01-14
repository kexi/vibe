import { assertEquals, assertThrows } from "@std/assert";
import { compareVersions, parseVersion } from "./upgrade.ts";

// parseVersion tests
Deno.test("parseVersion handles valid semver with 3 parts", () => {
  const result = parseVersion("1.2.3");
  assertEquals(result, [1, 2, 3]);
});

Deno.test("parseVersion handles version with commit hash suffix", () => {
  const result = parseVersion("1.2.3+abc1234");
  assertEquals(result, [1, 2, 3]);
});

Deno.test("parseVersion pads short versions with zeros", () => {
  assertEquals(parseVersion("1"), [1, 0, 0]);
  assertEquals(parseVersion("1.2"), [1, 2, 0]);
});

Deno.test("parseVersion handles zero versions", () => {
  assertEquals(parseVersion("0.0.0"), [0, 0, 0]);
  assertEquals(parseVersion("0.1.0"), [0, 1, 0]);
});

Deno.test("parseVersion throws on invalid version format", () => {
  assertThrows(
    () => parseVersion("invalid"),
    Error,
    "Invalid version format: invalid",
  );
});

Deno.test("parseVersion throws on empty string", () => {
  assertThrows(
    () => parseVersion(""),
    Error,
    "Invalid version format: ",
  );
});

Deno.test("parseVersion throws on version with non-numeric parts", () => {
  assertThrows(
    () => parseVersion("1.a.3"),
    Error,
    "Invalid version format: 1.a.3",
  );
});

// compareVersions tests
Deno.test("compareVersions returns negative when a < b", () => {
  const result = compareVersions("1.0.0", "2.0.0");
  assertEquals(result < 0, true);
});

Deno.test("compareVersions returns positive when a > b", () => {
  const result = compareVersions("2.0.0", "1.0.0");
  assertEquals(result > 0, true);
});

Deno.test("compareVersions returns 0 when versions are equal", () => {
  assertEquals(compareVersions("1.0.0", "1.0.0"), 0);
  assertEquals(compareVersions("1.2.3", "1.2.3"), 0);
});

Deno.test("compareVersions compares minor versions correctly", () => {
  assertEquals(compareVersions("1.1.0", "1.2.0") < 0, true);
  assertEquals(compareVersions("1.2.0", "1.1.0") > 0, true);
});

Deno.test("compareVersions compares patch versions correctly", () => {
  assertEquals(compareVersions("1.0.1", "1.0.2") < 0, true);
  assertEquals(compareVersions("1.0.2", "1.0.1") > 0, true);
});

Deno.test("compareVersions handles versions with commit hash suffix", () => {
  assertEquals(compareVersions("1.0.0+abc", "1.0.0+def"), 0);
  assertEquals(compareVersions("1.0.0+abc", "2.0.0+def") < 0, true);
});

Deno.test("compareVersions handles short versions", () => {
  assertEquals(compareVersions("1", "1.0.0"), 0);
  assertEquals(compareVersions("1.2", "1.2.0"), 0);
  assertEquals(compareVersions("1", "2") < 0, true);
});

Deno.test("compareVersions handles version ordering for sorting", () => {
  const versions = ["1.0.0", "2.0.0", "1.5.0", "1.0.1", "0.9.0"];
  versions.sort(compareVersions);
  assertEquals(versions, ["0.9.0", "1.0.0", "1.0.1", "1.5.0", "2.0.0"]);
});
