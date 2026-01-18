/**
 * Node.js filesystem implementation tests
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { nodeFS } from "../../packages/core/src/runtime/node/fs.ts";

let TEST_DIR: string;

beforeAll(async () => {
  TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "vibe_fs_test_"));
});

afterAll(async () => {
  try {
    await fs.rm(TEST_DIR, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe("nodeFS", () => {
  // ===== readTextFile Tests =====
  describe("readTextFile", () => {
    it("reads UTF-8 file content", async () => {
      const testFile = path.join(TEST_DIR, "read_test.txt");
      const content = "Hello, World!\n日本語テスト";
      await fs.writeFile(testFile, content);

      const result = await nodeFS.readTextFile(testFile);
      expect(result).toBe(content);
    });

    it("throws on non-existent file", async () => {
      const nonExistent = path.join(TEST_DIR, "non_existent.txt");
      await expect(nodeFS.readTextFile(nonExistent)).rejects.toThrow();
    });
  });

  // ===== readFile Tests =====
  describe("readFile", () => {
    it("reads binary file content", async () => {
      const testFile = path.join(TEST_DIR, "read_binary.bin");
      const content = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
      await fs.writeFile(testFile, content);

      const result = await nodeFS.readFile(testFile);
      expect(result).toEqual(content);
    });
  });

  // ===== writeTextFile Tests =====
  describe("writeTextFile", () => {
    it("creates new file", async () => {
      const testFile = path.join(TEST_DIR, "write_new.txt");
      const content = "New file content";

      await nodeFS.writeTextFile(testFile, content);

      const result = await fs.readFile(testFile, "utf-8");
      expect(result).toBe(content);
    });

    it("overwrites existing file", async () => {
      const testFile = path.join(TEST_DIR, "write_overwrite.txt");
      await fs.writeFile(testFile, "Original content");

      const newContent = "Overwritten content";
      await nodeFS.writeTextFile(testFile, newContent);

      const result = await fs.readFile(testFile, "utf-8");
      expect(result).toBe(newContent);
    });
  });

  // ===== mkdir Tests =====
  describe("mkdir", () => {
    it("creates directory", async () => {
      const testDir = path.join(TEST_DIR, "new_dir");
      await nodeFS.mkdir(testDir);

      const stat = await fs.stat(testDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("with recursive creates nested directories", async () => {
      const nestedDir = path.join(TEST_DIR, "nested", "deep", "dir");
      await nodeFS.mkdir(nestedDir, { recursive: true });

      const stat = await fs.stat(nestedDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  // ===== remove Tests =====
  describe("remove", () => {
    it("deletes file", async () => {
      const testFile = path.join(TEST_DIR, "to_delete.txt");
      await fs.writeFile(testFile, "Delete me");

      await nodeFS.remove(testFile);

      await expect(fs.stat(testFile)).rejects.toThrow();
    });

    it("with recursive deletes directory tree", async () => {
      const testDir = path.join(TEST_DIR, "dir_to_delete");
      await fs.mkdir(testDir);
      await fs.writeFile(path.join(testDir, "file.txt"), "content");

      await nodeFS.remove(testDir, { recursive: true });

      await expect(fs.stat(testDir)).rejects.toThrow();
    });
  });

  // ===== rename Tests =====
  describe("rename", () => {
    it("moves file", async () => {
      const src = path.join(TEST_DIR, "rename_src.txt");
      const dest = path.join(TEST_DIR, "rename_dest.txt");
      await fs.writeFile(src, "Rename me");

      await nodeFS.rename(src, dest);

      await expect(fs.stat(src)).rejects.toThrow();
      const content = await fs.readFile(dest, "utf-8");
      expect(content).toBe("Rename me");
    });
  });

  // ===== stat Tests =====
  describe("stat", () => {
    it("returns file info for file", async () => {
      const testFile = path.join(TEST_DIR, "stat_file.txt");
      await fs.writeFile(testFile, "Stat test");

      const info = await nodeFS.stat(testFile);
      expect(info.isFile).toBe(true);
      expect(info.isDirectory).toBe(false);
      expect(info.size).toBeDefined();
    });

    it("returns file info for directory", async () => {
      const testDir = path.join(TEST_DIR, "stat_dir");
      await fs.mkdir(testDir);

      const info = await nodeFS.stat(testDir);
      expect(info.isFile).toBe(false);
      expect(info.isDirectory).toBe(true);
    });
  });

  // ===== lstat Tests =====
  describe("lstat", () => {
    it("returns symlink info without following", async () => {
      const target = path.join(TEST_DIR, "lstat_target.txt");
      const link = path.join(TEST_DIR, "lstat_link");
      await fs.writeFile(target, "Target");
      await fs.symlink(target, link);

      const info = await nodeFS.lstat(link);
      expect(info.isSymlink).toBe(true);
    });
  });

  // ===== copyFile Tests =====
  describe("copyFile", () => {
    it("copies file content", async () => {
      const src = path.join(TEST_DIR, "copy_src.txt");
      const dest = path.join(TEST_DIR, "copy_dest.txt");
      const content = "Copy me";
      await fs.writeFile(src, content);

      await nodeFS.copyFile(src, dest);

      const result = await fs.readFile(dest, "utf-8");
      expect(result).toBe(content);
    });
  });

  // ===== readDir Tests =====
  describe("readDir", () => {
    it("returns directory entries", async () => {
      const testDir = path.join(TEST_DIR, "readdir_test");
      await fs.mkdir(testDir);
      await fs.writeFile(path.join(testDir, "file1.txt"), "1");
      await fs.writeFile(path.join(testDir, "file2.txt"), "2");
      await fs.mkdir(path.join(testDir, "subdir"));

      const entries: string[] = [];
      for await (const entry of nodeFS.readDir(testDir)) {
        entries.push(entry.name);
      }

      expect(entries.sort()).toEqual(["file1.txt", "file2.txt", "subdir"]);
    });
  });

  // ===== realPath Tests =====
  describe("realPath", () => {
    it("resolves symlinks to absolute path", async () => {
      const target = path.join(TEST_DIR, "realpath_target.txt");
      const link = path.join(TEST_DIR, "realpath_link");
      await fs.writeFile(target, "Target");
      await fs.symlink(target, link);

      const resolved = await nodeFS.realPath(link);
      expect(resolved).toBe(await fs.realpath(target));
    });
  });

  // ===== exists Tests =====
  describe("exists", () => {
    it("returns true for existing file", async () => {
      const testFile = path.join(TEST_DIR, "exists_file.txt");
      await fs.writeFile(testFile, "Exists");

      const result = await nodeFS.exists(testFile);
      expect(result).toBe(true);
    });

    it("returns false for non-existent file", async () => {
      const nonExistent = path.join(TEST_DIR, "not_exists.txt");
      const result = await nodeFS.exists(nonExistent);
      expect(result).toBe(false);
    });
  });

  // ===== makeTempDir Tests =====
  describe("makeTempDir", () => {
    it("creates temporary directory", async () => {
      const tempDir = await nodeFS.makeTempDir({ prefix: "vitest_" });

      try {
        const stat = await fs.stat(tempDir);
        expect(stat.isDirectory()).toBe(true);
        expect(tempDir).toContain("vitest_");
      } finally {
        await fs.rm(tempDir, { recursive: true });
      }
    });
  });
});
