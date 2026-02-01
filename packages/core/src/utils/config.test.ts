import { describe, it, expect } from "vitest";
import { mergeArrayField, mergeConfigs } from "./config.ts";
import type { VibeConfig } from "../types/config.ts";

describe("mergeArrayField", () => {
  it("override takes precedence", () => {
    const result = mergeArrayField(
      ["base1", "base2"],
      ["override1", "override2"],
      ["prepend1"],
      ["append1"],
    );
    expect(result).toEqual(["override1", "override2"]);
  });

  it("prepend and append with base", () => {
    const result = mergeArrayField(["base1", "base2"], undefined, ["prepend1"], ["append1"]);
    expect(result).toEqual(["prepend1", "base1", "base2", "append1"]);
  });

  it("only prepend", () => {
    const result = mergeArrayField(["base1", "base2"], undefined, ["prepend1"], undefined);
    expect(result).toEqual(["prepend1", "base1", "base2"]);
  });

  it("only append", () => {
    const result = mergeArrayField(["base1", "base2"], undefined, undefined, ["append1"]);
    expect(result).toEqual(["base1", "base2", "append1"]);
  });

  it("base only", () => {
    const result = mergeArrayField(["base1", "base2"], undefined, undefined, undefined);
    expect(result).toEqual(["base1", "base2"]);
  });

  it("no base with prepend and append", () => {
    const result = mergeArrayField(undefined, undefined, ["prepend1"], ["append1"]);
    expect(result).toEqual(["prepend1", "append1"]);
  });

  it("all undefined", () => {
    const result = mergeArrayField(undefined, undefined, undefined, undefined);
    expect(result).toEqual(undefined);
  });

  it("empty arrays", () => {
    const result = mergeArrayField([], undefined, [], []);
    expect(result).toEqual([]);
  });
});

describe("mergeConfigs", () => {
  it("copy files merging with append", () => {
    const baseConfig: VibeConfig = {
      copy: { files: [".env"] },
    };
    const localConfig: VibeConfig = {
      copy: { files_append: [".env.local"] },
    };

    const result = mergeConfigs(baseConfig, localConfig);

    expect(result.copy?.files).toEqual([".env", ".env.local"]);
  });

  it("copy files override", () => {
    const baseConfig: VibeConfig = {
      copy: { files: [".env"] },
    };
    const localConfig: VibeConfig = {
      copy: { files: [".local"] },
    };

    const result = mergeConfigs(baseConfig, localConfig);

    expect(result.copy?.files).toEqual([".local"]);
  });

  it("hooks pre_start merging", () => {
    const baseConfig: VibeConfig = {
      hooks: { pre_start: ["echo 'base'"] },
    };
    const localConfig: VibeConfig = {
      hooks: { pre_start_prepend: ["echo 'before'"] },
    };

    const result = mergeConfigs(baseConfig, localConfig);

    expect(result.hooks?.pre_start).toEqual(["echo 'before'", "echo 'base'"]);
  });

  it("hooks post_start merging", () => {
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

    expect(result.hooks?.post_start).toEqual([
      "echo 'local pre'",
      "mise trust",
      "mise install",
      "npm run dev",
    ]);
  });

  it("hooks pre_clean merging", () => {
    const baseConfig: VibeConfig = {
      hooks: { pre_clean: ["git stash"] },
    };
    const localConfig: VibeConfig = {
      hooks: { pre_clean_append: ["echo 'cleanup'"] },
    };

    const result = mergeConfigs(baseConfig, localConfig);

    expect(result.hooks?.pre_clean).toEqual(["git stash", "echo 'cleanup'"]);
  });

  it("hooks post_clean merging", () => {
    const baseConfig: VibeConfig = {
      hooks: { post_clean: ["echo 'done'"] },
    };
    const localConfig: VibeConfig = {
      hooks: { post_clean_prepend: ["cd /path"] },
    };

    const result = mergeConfigs(baseConfig, localConfig);

    expect(result.hooks?.post_clean).toEqual(["cd /path", "echo 'done'"]);
  });

  it("multiple hooks merging", () => {
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

    expect(result.hooks?.pre_start).toEqual(["echo 'pre'", "echo 'local pre'"]);
    expect(result.hooks?.post_start).toEqual(["echo 'local post'", "echo 'post'"]);
    expect(result.hooks?.pre_clean).toEqual(["echo 'clean'"]);
  });

  it("empty configs", () => {
    const baseConfig: VibeConfig = {};
    const localConfig: VibeConfig = {};

    const result = mergeConfigs(baseConfig, localConfig);

    expect(result.copy).toEqual(undefined);
    expect(result.hooks).toEqual(undefined);
  });

  it("complex scenario", () => {
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

    expect(result.copy?.files).toEqual([".env", ".env.local"]);
    expect(result.hooks?.pre_start).toEqual(["echo 'local setup'", "echo 'preparing'"]);
    expect(result.hooks?.post_start).toEqual(["mise trust", "mise install", "npm run dev"]);
    expect(result.hooks?.pre_clean).toEqual(["git stash"]);
  });

  it("local config only", () => {
    const baseConfig: VibeConfig = {};
    const localConfig: VibeConfig = {
      copy: { files: [".local"] },
      hooks: { post_start: ["echo 'local'"] },
    };

    const result = mergeConfigs(baseConfig, localConfig);

    expect(result.copy?.files).toEqual([".local"]);
    expect(result.hooks?.post_start).toEqual(["echo 'local'"]);
  });

  it("glob patterns in copy files", () => {
    const baseConfig: VibeConfig = {
      copy: { files: ["*.env"] },
    };
    const localConfig: VibeConfig = {
      copy: { files_append: ["config/*.json"] },
    };

    const result = mergeConfigs(baseConfig, localConfig);

    expect(result.copy?.files).toEqual(["*.env", "config/*.json"]);
  });

  it("glob patterns with override", () => {
    const baseConfig: VibeConfig = {
      copy: { files: ["*.env", "*.txt"] },
    };
    const localConfig: VibeConfig = {
      copy: { files: ["**/*.json"] },
    };

    const result = mergeConfigs(baseConfig, localConfig);

    // Local config should override base config
    expect(result.copy?.files).toEqual(["**/*.json"]);
  });

  it("mix of exact paths and glob patterns", () => {
    const baseConfig: VibeConfig = {
      copy: { files: [".env", "*.config.js"] },
    };
    const localConfig: VibeConfig = {
      copy: { files_prepend: ["**/*.local.env"] },
    };

    const result = mergeConfigs(baseConfig, localConfig);

    expect(result.copy?.files).toEqual(["**/*.local.env", ".env", "*.config.js"]);
  });

  it("concurrency from base config", () => {
    const baseConfig: VibeConfig = {
      copy: { concurrency: 8 },
    };
    const localConfig: VibeConfig = {};

    const result = mergeConfigs(baseConfig, localConfig);

    expect(result.copy?.concurrency).toBe(8);
  });

  it("concurrency from local config", () => {
    const baseConfig: VibeConfig = {};
    const localConfig: VibeConfig = {
      copy: { concurrency: 16 },
    };

    const result = mergeConfigs(baseConfig, localConfig);

    expect(result.copy?.concurrency).toBe(16);
  });

  it("local concurrency takes precedence over base", () => {
    const baseConfig: VibeConfig = {
      copy: { concurrency: 4 },
    };
    const localConfig: VibeConfig = {
      copy: { concurrency: 8 },
    };

    const result = mergeConfigs(baseConfig, localConfig);

    expect(result.copy?.concurrency).toBe(8);
  });

  it("concurrency with other copy fields", () => {
    const baseConfig: VibeConfig = {
      copy: { files: [".env"], concurrency: 4 },
    };
    const localConfig: VibeConfig = {
      copy: { files_append: [".env.local"], concurrency: 16 },
    };

    const result = mergeConfigs(baseConfig, localConfig);

    expect(result.copy?.files).toEqual([".env", ".env.local"]);
    expect(result.copy?.concurrency).toBe(16);
  });

  it("concurrency only in base with other fields in local", () => {
    const baseConfig: VibeConfig = {
      copy: { concurrency: 8 },
    };
    const localConfig: VibeConfig = {
      copy: { files: [".env"] },
    };

    const result = mergeConfigs(baseConfig, localConfig);

    expect(result.copy?.files).toEqual([".env"]);
    expect(result.copy?.concurrency).toBe(8);
  });
});
