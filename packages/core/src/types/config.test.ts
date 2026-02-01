import { describe, it, expect } from "vitest";
import { parseVibeConfig, VibeConfigSchema } from "./config.ts";

describe("parseVibeConfig", () => {
  it("accepts valid empty config", () => {
    const result = parseVibeConfig({}, "/path/to/.vibe.toml");
    expect(result).toEqual({});
  });

  it("accepts valid config with all sections", () => {
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
    expect(result).toEqual(config);
  });

  it("accepts config with prepend/append arrays", () => {
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
    expect(result).toEqual(config);
  });

  it("rejects unknown top-level property (strict mode)", () => {
    const config = {
      unknown_property: "value",
    };

    expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(/\/path\/to\/.vibe.toml/);
    expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(/unknown_property/);
  });

  it("rejects unknown nested property", () => {
    const config = {
      copy: {
        files: ["file.txt"],
        unknown_nested: "value",
      },
    };

    expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(/\/path\/to\/.vibe.toml/);
  });

  it("rejects invalid type - string instead of array", () => {
    const config = {
      copy: {
        files: "not-an-array",
      },
    };

    expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(/\/path\/to\/.vibe.toml/);
    expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(/copy\.files/);
  });

  it("rejects invalid type - number instead of boolean", () => {
    const config = {
      clean: {
        delete_branch: 123,
      },
    };

    expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(/\/path\/to\/.vibe.toml/);
    expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(/clean\.delete_branch/);
  });

  it("rejects invalid array element type", () => {
    const config = {
      hooks: {
        pre_start: [123, 456],
      },
    };

    expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(/\/path\/to\/.vibe.toml/);
  });

  it("error message includes file path", () => {
    const customPath = "/custom/path/to/config.toml";
    const config = { invalid: true };

    expect(() => parseVibeConfig(config, customPath)).toThrow(customPath);
  });

  describe("copy concurrency", () => {
    it("accepts valid concurrency", () => {
      const config = {
        copy: {
          concurrency: 8,
        },
      };

      const result = parseVibeConfig(config, "/path/to/.vibe.toml");
      expect(result.copy?.concurrency).toBe(8);
    });

    it("accepts minimum concurrency (1)", () => {
      const config = {
        copy: {
          concurrency: 1,
        },
      };

      const result = parseVibeConfig(config, "/path/to/.vibe.toml");
      expect(result.copy?.concurrency).toBe(1);
    });

    it("accepts maximum concurrency (32)", () => {
      const config = {
        copy: {
          concurrency: 32,
        },
      };

      const result = parseVibeConfig(config, "/path/to/.vibe.toml");
      expect(result.copy?.concurrency).toBe(32);
    });

    it("rejects concurrency below minimum", () => {
      const config = {
        copy: {
          concurrency: 0,
        },
      };

      expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(
        /\/path\/to\/.vibe.toml/,
      );
      expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(/copy\.concurrency/);
    });

    it("rejects concurrency above maximum", () => {
      const config = {
        copy: {
          concurrency: 33,
        },
      };

      expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(
        /\/path\/to\/.vibe.toml/,
      );
      expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(/copy\.concurrency/);
    });

    it("rejects non-integer concurrency", () => {
      const config = {
        copy: {
          concurrency: 4.5,
        },
      };

      expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(
        /\/path\/to\/.vibe.toml/,
      );
      expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(/copy\.concurrency/);
    });

    it("rejects string concurrency", () => {
      const config = {
        copy: {
          concurrency: "4",
        },
      };

      expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(
        /\/path\/to\/.vibe.toml/,
      );
      expect(() => parseVibeConfig(config, "/path/to/.vibe.toml")).toThrow(/copy\.concurrency/);
    });
  });
});

describe("VibeConfigSchema", () => {
  it("validates all hook types", () => {
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
    expect(result.success).toBe(true);
  });
});
