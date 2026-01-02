import { assertEquals } from "@std/assert";
import { mergeArrayField, mergeConfigs } from "./config.ts";
import type { VibeConfig } from "../types/config.ts";

Deno.test("mergeArrayField: override takes precedence", () => {
  const result = mergeArrayField(
    ["base1", "base2"],
    ["override1", "override2"],
    ["prepend1"],
    ["append1"],
  );
  assertEquals(result, ["override1", "override2"]);
});

Deno.test("mergeArrayField: prepend and append with base", () => {
  const result = mergeArrayField(
    ["base1", "base2"],
    undefined,
    ["prepend1"],
    ["append1"],
  );
  assertEquals(result, ["prepend1", "base1", "base2", "append1"]);
});

Deno.test("mergeArrayField: only prepend", () => {
  const result = mergeArrayField(
    ["base1", "base2"],
    undefined,
    ["prepend1"],
    undefined,
  );
  assertEquals(result, ["prepend1", "base1", "base2"]);
});

Deno.test("mergeArrayField: only append", () => {
  const result = mergeArrayField(
    ["base1", "base2"],
    undefined,
    undefined,
    ["append1"],
  );
  assertEquals(result, ["base1", "base2", "append1"]);
});

Deno.test("mergeArrayField: base only", () => {
  const result = mergeArrayField(
    ["base1", "base2"],
    undefined,
    undefined,
    undefined,
  );
  assertEquals(result, ["base1", "base2"]);
});

Deno.test("mergeArrayField: no base with prepend and append", () => {
  const result = mergeArrayField(
    undefined,
    undefined,
    ["prepend1"],
    ["append1"],
  );
  assertEquals(result, ["prepend1", "append1"]);
});

Deno.test("mergeArrayField: all undefined", () => {
  const result = mergeArrayField(
    undefined,
    undefined,
    undefined,
    undefined,
  );
  assertEquals(result, undefined);
});

Deno.test("mergeArrayField: empty arrays", () => {
  const result = mergeArrayField(
    [],
    undefined,
    [],
    [],
  );
  assertEquals(result, []);
});

Deno.test("mergeConfigs: copy files merging with append", () => {
  const baseConfig: VibeConfig = {
    copy: { files: [".env"] },
  };
  const localConfig: VibeConfig = {
    copy: { files_append: [".env.local"] },
  };

  const result = mergeConfigs(baseConfig, localConfig);

  assertEquals(result.copy?.files, [".env", ".env.local"]);
});

Deno.test("mergeConfigs: copy files override", () => {
  const baseConfig: VibeConfig = {
    copy: { files: [".env"] },
  };
  const localConfig: VibeConfig = {
    copy: { files: [".local"] },
  };

  const result = mergeConfigs(baseConfig, localConfig);

  assertEquals(result.copy?.files, [".local"]);
});

Deno.test("mergeConfigs: hooks pre_start merging", () => {
  const baseConfig: VibeConfig = {
    hooks: { pre_start: ["echo 'base'"] },
  };
  const localConfig: VibeConfig = {
    hooks: { pre_start_prepend: ["echo 'before'"] },
  };

  const result = mergeConfigs(baseConfig, localConfig);

  assertEquals(result.hooks?.pre_start, ["echo 'before'", "echo 'base'"]);
});

Deno.test("mergeConfigs: hooks post_start merging", () => {
  const baseConfig: VibeConfig = {
    hooks: { post_start: ["mise trust", "mise install"] },
  };
  const localConfig: VibeConfig = {
    hooks: {
      post_start_prepend: ["echo 'local pre'"],
      post_start_append: ["npm run dev"],
    },
  };

  const result = mergeConfigs(baseConfig, localConfig);

  assertEquals(result.hooks?.post_start, [
    "echo 'local pre'",
    "mise trust",
    "mise install",
    "npm run dev",
  ]);
});

Deno.test("mergeConfigs: hooks pre_clean merging", () => {
  const baseConfig: VibeConfig = {
    hooks: { pre_clean: ["git stash"] },
  };
  const localConfig: VibeConfig = {
    hooks: { pre_clean_append: ["echo 'cleanup'"] },
  };

  const result = mergeConfigs(baseConfig, localConfig);

  assertEquals(result.hooks?.pre_clean, ["git stash", "echo 'cleanup'"]);
});

Deno.test("mergeConfigs: hooks post_clean merging", () => {
  const baseConfig: VibeConfig = {
    hooks: { post_clean: ["echo 'done'"] },
  };
  const localConfig: VibeConfig = {
    hooks: { post_clean_prepend: ["cd /path"] },
  };

  const result = mergeConfigs(baseConfig, localConfig);

  assertEquals(result.hooks?.post_clean, ["cd /path", "echo 'done'"]);
});

Deno.test("mergeConfigs: multiple hooks merging", () => {
  const baseConfig: VibeConfig = {
    hooks: {
      pre_start: ["echo 'pre'"],
      post_start: ["echo 'post'"],
    },
  };
  const localConfig: VibeConfig = {
    hooks: {
      pre_start_append: ["echo 'local pre'"],
      post_start_prepend: ["echo 'local post'"],
      pre_clean: ["echo 'clean'"],
    },
  };

  const result = mergeConfigs(baseConfig, localConfig);

  assertEquals(result.hooks?.pre_start, ["echo 'pre'", "echo 'local pre'"]);
  assertEquals(result.hooks?.post_start, ["echo 'local post'", "echo 'post'"]);
  assertEquals(result.hooks?.pre_clean, ["echo 'clean'"]);
});

Deno.test("mergeConfigs: empty configs", () => {
  const baseConfig: VibeConfig = {};
  const localConfig: VibeConfig = {};

  const result = mergeConfigs(baseConfig, localConfig);

  assertEquals(result.copy, undefined);
  assertEquals(result.hooks, undefined);
});

Deno.test("mergeConfigs: complex scenario", () => {
  const baseConfig: VibeConfig = {
    copy: { files: [".env"] },
    hooks: {
      pre_start: ["echo 'preparing'"],
      post_start: ["mise trust", "mise install"],
    },
  };
  const localConfig: VibeConfig = {
    copy: { files_append: [".env.local"] },
    hooks: {
      pre_start_prepend: ["echo 'local setup'"],
      post_start_append: ["npm run dev"],
      pre_clean: ["git stash"],
    },
  };

  const result = mergeConfigs(baseConfig, localConfig);

  assertEquals(result.copy?.files, [".env", ".env.local"]);
  assertEquals(result.hooks?.pre_start, [
    "echo 'local setup'",
    "echo 'preparing'",
  ]);
  assertEquals(result.hooks?.post_start, [
    "mise trust",
    "mise install",
    "npm run dev",
  ]);
  assertEquals(result.hooks?.pre_clean, ["git stash"]);
});

Deno.test("mergeConfigs: local config only", () => {
  const baseConfig: VibeConfig = {};
  const localConfig: VibeConfig = {
    copy: { files: [".local"] },
    hooks: { post_start: ["echo 'local'"] },
  };

  const result = mergeConfigs(baseConfig, localConfig);

  assertEquals(result.copy?.files, [".local"]);
  assertEquals(result.hooks?.post_start, ["echo 'local'"]);
});

Deno.test("mergeConfigs: glob patterns in copy files", () => {
  const baseConfig: VibeConfig = {
    copy: { files: ["*.env"] },
  };
  const localConfig: VibeConfig = {
    copy: { files_append: ["config/*.json"] },
  };

  const result = mergeConfigs(baseConfig, localConfig);

  assertEquals(result.copy?.files, ["*.env", "config/*.json"]);
});

Deno.test("mergeConfigs: glob patterns with override", () => {
  const baseConfig: VibeConfig = {
    copy: { files: ["*.env", "*.txt"] },
  };
  const localConfig: VibeConfig = {
    copy: { files: ["**/*.json"] },
  };

  const result = mergeConfigs(baseConfig, localConfig);

  // Local config should override base config
  assertEquals(result.copy?.files, ["**/*.json"]);
});

Deno.test("mergeConfigs: mix of exact paths and glob patterns", () => {
  const baseConfig: VibeConfig = {
    copy: { files: [".env", "*.config.js"] },
  };
  const localConfig: VibeConfig = {
    copy: { files_prepend: ["**/*.local.env"] },
  };

  const result = mergeConfigs(baseConfig, localConfig);

  assertEquals(result.copy?.files, ["**/*.local.env", ".env", "*.config.js"]);
});
