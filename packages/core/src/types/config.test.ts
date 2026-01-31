import { assertEquals, assertThrows } from "@std/assert";
import { parseVibeConfig, VibeConfigSchema } from "./config.ts";

Deno.test("parseVibeConfig: accepts valid empty config", () => {
  const result = parseVibeConfig({}, "/path/to/.vibe.toml");
  assertEquals(result, {});
});

Deno.test("parseVibeConfig: accepts valid config with all sections", () => {
  const config = {
    copy: {
      files: ["file1.txt", "file2.txt"],
      dirs: ["dir1", "dir2"],
    },
    hooks: {
      pre_start: ["echo pre"],
      post_start: ["echo post"],
    },
    worktree: {
      path_script: "/path/to/script.sh",
    },
    clean: {
      delete_branch: true,
    },
  };

  const result = parseVibeConfig(config, "/path/to/.vibe.toml");
  assertEquals(result, config);
});

Deno.test("parseVibeConfig: accepts config with prepend/append arrays", () => {
  const config = {
    copy: {
      files_prepend: ["first.txt"],
      files_append: ["last.txt"],
      dirs_prepend: ["first-dir"],
      dirs_append: ["last-dir"],
    },
    hooks: {
      pre_start_prepend: ["echo first"],
      pre_start_append: ["echo last"],
    },
  };

  const result = parseVibeConfig(config, "/path/to/.vibe.toml");
  assertEquals(result, config);
});

Deno.test("parseVibeConfig: rejects unknown top-level property (strict mode)", () => {
  const config = {
    unknown_property: "value",
  };

  const error = assertThrows(
    () => parseVibeConfig(config, "/path/to/.vibe.toml"),
    Error,
  );
  assertEquals(error.message.includes("/path/to/.vibe.toml"), true);
  assertEquals(error.message.includes("unknown_property"), true);
});

Deno.test("parseVibeConfig: rejects unknown nested property", () => {
  const config = {
    copy: {
      files: ["file.txt"],
      unknown_nested: "value",
    },
  };

  const error = assertThrows(
    () => parseVibeConfig(config, "/path/to/.vibe.toml"),
    Error,
  );
  assertEquals(error.message.includes("/path/to/.vibe.toml"), true);
});

Deno.test("parseVibeConfig: rejects invalid type - string instead of array", () => {
  const config = {
    copy: {
      files: "not-an-array",
    },
  };

  const error = assertThrows(
    () => parseVibeConfig(config, "/path/to/.vibe.toml"),
    Error,
  );
  assertEquals(error.message.includes("/path/to/.vibe.toml"), true);
  assertEquals(error.message.includes("copy.files"), true);
});

Deno.test("parseVibeConfig: rejects invalid type - number instead of boolean", () => {
  const config = {
    clean: {
      delete_branch: 123,
    },
  };

  const error = assertThrows(
    () => parseVibeConfig(config, "/path/to/.vibe.toml"),
    Error,
  );
  assertEquals(error.message.includes("/path/to/.vibe.toml"), true);
  assertEquals(error.message.includes("clean.delete_branch"), true);
});

Deno.test("parseVibeConfig: rejects invalid array element type", () => {
  const config = {
    hooks: {
      pre_start: [123, 456],
    },
  };

  const error = assertThrows(
    () => parseVibeConfig(config, "/path/to/.vibe.toml"),
    Error,
  );
  assertEquals(error.message.includes("/path/to/.vibe.toml"), true);
});

Deno.test("parseVibeConfig: error message includes file path", () => {
  const customPath = "/custom/path/to/config.toml";
  const config = { invalid: true };

  const error = assertThrows(
    () => parseVibeConfig(config, customPath),
    Error,
  );
  assertEquals(error.message.includes(customPath), true);
});

Deno.test("parseVibeConfig: accepts valid copy concurrency", () => {
  const config = {
    copy: {
      concurrency: 8,
    },
  };

  const result = parseVibeConfig(config, "/path/to/.vibe.toml");
  assertEquals(result.copy?.concurrency, 8);
});

Deno.test("parseVibeConfig: accepts minimum copy concurrency (1)", () => {
  const config = {
    copy: {
      concurrency: 1,
    },
  };

  const result = parseVibeConfig(config, "/path/to/.vibe.toml");
  assertEquals(result.copy?.concurrency, 1);
});

Deno.test("parseVibeConfig: accepts maximum copy concurrency (32)", () => {
  const config = {
    copy: {
      concurrency: 32,
    },
  };

  const result = parseVibeConfig(config, "/path/to/.vibe.toml");
  assertEquals(result.copy?.concurrency, 32);
});

Deno.test("parseVibeConfig: rejects copy concurrency below minimum", () => {
  const config = {
    copy: {
      concurrency: 0,
    },
  };

  const error = assertThrows(
    () => parseVibeConfig(config, "/path/to/.vibe.toml"),
    Error,
  );
  assertEquals(error.message.includes("/path/to/.vibe.toml"), true);
  assertEquals(error.message.includes("copy.concurrency"), true);
});

Deno.test("parseVibeConfig: rejects copy concurrency above maximum", () => {
  const config = {
    copy: {
      concurrency: 33,
    },
  };

  const error = assertThrows(
    () => parseVibeConfig(config, "/path/to/.vibe.toml"),
    Error,
  );
  assertEquals(error.message.includes("/path/to/.vibe.toml"), true);
  assertEquals(error.message.includes("copy.concurrency"), true);
});

Deno.test("parseVibeConfig: rejects non-integer copy concurrency", () => {
  const config = {
    copy: {
      concurrency: 4.5,
    },
  };

  const error = assertThrows(
    () => parseVibeConfig(config, "/path/to/.vibe.toml"),
    Error,
  );
  assertEquals(error.message.includes("/path/to/.vibe.toml"), true);
  assertEquals(error.message.includes("copy.concurrency"), true);
});

Deno.test("parseVibeConfig: rejects string copy concurrency", () => {
  const config = {
    copy: {
      concurrency: "4",
    },
  };

  const error = assertThrows(
    () => parseVibeConfig(config, "/path/to/.vibe.toml"),
    Error,
  );
  assertEquals(error.message.includes("/path/to/.vibe.toml"), true);
  assertEquals(error.message.includes("copy.concurrency"), true);
});

Deno.test("VibeConfigSchema: validates all hook types", () => {
  const config = {
    hooks: {
      pre_start: ["cmd1"],
      pre_start_prepend: ["cmd2"],
      pre_start_append: ["cmd3"],
      post_start: ["cmd4"],
      post_start_prepend: ["cmd5"],
      post_start_append: ["cmd6"],
      pre_clean: ["cmd7"],
      pre_clean_prepend: ["cmd8"],
      pre_clean_append: ["cmd9"],
      post_clean: ["cmd10"],
      post_clean_prepend: ["cmd11"],
      post_clean_append: ["cmd12"],
    },
  };

  const result = VibeConfigSchema.safeParse(config);
  assertEquals(result.success, true);
});
