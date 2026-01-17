/**
 * Deno filesystem implementation tests
 */

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { denoFS } from "./fs.ts";

// Use a temporary directory for tests
const TEST_DIR = await Deno.makeTempDir({ prefix: "vibe_fs_test_" });

// Cleanup after all tests (use sync to avoid pending Promise issues)
globalThis.addEventListener("unload", () => {
  try {
    Deno.removeSync(TEST_DIR, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ===== readTextFile Tests =====

Deno.test("readTextFile reads UTF-8 file content", async () => {
  const testFile = join(TEST_DIR, "read_test.txt");
  const content = "Hello, World!\n日本語テスト";
  await Deno.writeTextFile(testFile, content);

  const result = await denoFS.readTextFile(testFile);
  assertEquals(result, content);
});

Deno.test("readTextFile throws on non-existent file", async () => {
  const nonExistent = join(TEST_DIR, "non_existent.txt");
  await assertRejects(
    () => denoFS.readTextFile(nonExistent),
    Deno.errors.NotFound,
  );
});

// ===== readFile Tests =====

Deno.test("readFile reads binary file content", async () => {
  const testFile = join(TEST_DIR, "read_binary.bin");
  const content = new Uint8Array([0x00, 0x01, 0x02, 0xFF]);
  await Deno.writeFile(testFile, content);

  const result = await denoFS.readFile(testFile);
  assertEquals(result, content);
});

// ===== writeTextFile Tests =====

Deno.test("writeTextFile creates new file", async () => {
  const testFile = join(TEST_DIR, "write_new.txt");
  const content = "New file content";

  await denoFS.writeTextFile(testFile, content);

  const result = await Deno.readTextFile(testFile);
  assertEquals(result, content);
});

Deno.test("writeTextFile overwrites existing file", async () => {
  const testFile = join(TEST_DIR, "write_overwrite.txt");
  await Deno.writeTextFile(testFile, "Original content");

  const newContent = "Overwritten content";
  await denoFS.writeTextFile(testFile, newContent);

  const result = await Deno.readTextFile(testFile);
  assertEquals(result, newContent);
});

// ===== mkdir Tests =====

Deno.test("mkdir creates directory", async () => {
  const testDir = join(TEST_DIR, "new_dir");
  await denoFS.mkdir(testDir);

  const stat = await Deno.stat(testDir);
  assertEquals(stat.isDirectory, true);
});

Deno.test("mkdir with recursive creates nested directories", async () => {
  const nestedDir = join(TEST_DIR, "nested", "deep", "dir");
  await denoFS.mkdir(nestedDir, { recursive: true });

  const stat = await Deno.stat(nestedDir);
  assertEquals(stat.isDirectory, true);
});

// ===== remove Tests =====

Deno.test("remove deletes file", async () => {
  const testFile = join(TEST_DIR, "to_delete.txt");
  await Deno.writeTextFile(testFile, "Delete me");

  await denoFS.remove(testFile);

  await assertRejects(
    () => Deno.stat(testFile),
    Deno.errors.NotFound,
  );
});

Deno.test("remove with recursive deletes directory tree", async () => {
  const testDir = join(TEST_DIR, "dir_to_delete");
  await Deno.mkdir(testDir);
  await Deno.writeTextFile(join(testDir, "file.txt"), "content");

  await denoFS.remove(testDir, { recursive: true });

  await assertRejects(
    () => Deno.stat(testDir),
    Deno.errors.NotFound,
  );
});

// ===== rename Tests =====

Deno.test("rename moves file", async () => {
  const src = join(TEST_DIR, "rename_src.txt");
  const dest = join(TEST_DIR, "rename_dest.txt");
  await Deno.writeTextFile(src, "Rename me");

  await denoFS.rename(src, dest);

  await assertRejects(() => Deno.stat(src), Deno.errors.NotFound);
  const content = await Deno.readTextFile(dest);
  assertEquals(content, "Rename me");
});

// ===== stat Tests =====

Deno.test("stat returns file info for file", async () => {
  const testFile = join(TEST_DIR, "stat_file.txt");
  await Deno.writeTextFile(testFile, "Stat test");

  const info = await denoFS.stat(testFile);
  assertEquals(info.isFile, true);
  assertEquals(info.isDirectory, false);
  assertExists(info.size);
});

Deno.test("stat returns file info for directory", async () => {
  const testDir = join(TEST_DIR, "stat_dir");
  await Deno.mkdir(testDir);

  const info = await denoFS.stat(testDir);
  assertEquals(info.isFile, false);
  assertEquals(info.isDirectory, true);
});

// ===== lstat Tests =====

Deno.test("lstat returns symlink info without following", async () => {
  const target = join(TEST_DIR, "lstat_target.txt");
  const link = join(TEST_DIR, "lstat_link");
  await Deno.writeTextFile(target, "Target");
  await Deno.symlink(target, link);

  const info = await denoFS.lstat(link);
  assertEquals(info.isSymlink, true);
});

// ===== copyFile Tests =====

Deno.test("copyFile copies file content", async () => {
  const src = join(TEST_DIR, "copy_src.txt");
  const dest = join(TEST_DIR, "copy_dest.txt");
  const content = "Copy me";
  await Deno.writeTextFile(src, content);

  await denoFS.copyFile(src, dest);

  const result = await Deno.readTextFile(dest);
  assertEquals(result, content);
});

// ===== readDir Tests =====

Deno.test("readDir returns directory entries", async () => {
  const testDir = join(TEST_DIR, "readdir_test");
  await Deno.mkdir(testDir);
  await Deno.writeTextFile(join(testDir, "file1.txt"), "1");
  await Deno.writeTextFile(join(testDir, "file2.txt"), "2");
  await Deno.mkdir(join(testDir, "subdir"));

  const entries: string[] = [];
  for await (const entry of denoFS.readDir(testDir)) {
    entries.push(entry.name);
  }

  assertEquals(entries.sort(), ["file1.txt", "file2.txt", "subdir"]);
});

// ===== realPath Tests =====

Deno.test("realPath resolves symlinks to absolute path", async () => {
  const target = join(TEST_DIR, "realpath_target.txt");
  const link = join(TEST_DIR, "realpath_link");
  await Deno.writeTextFile(target, "Target");
  await Deno.symlink(target, link);

  const resolved = await denoFS.realPath(link);
  assertEquals(resolved, await Deno.realPath(target));
});

// ===== exists Tests =====

Deno.test("exists returns true for existing file", async () => {
  const testFile = join(TEST_DIR, "exists_file.txt");
  await Deno.writeTextFile(testFile, "Exists");

  const result = await denoFS.exists(testFile);
  assertEquals(result, true);
});

Deno.test("exists returns false for non-existent file", async () => {
  const nonExistent = join(TEST_DIR, "not_exists.txt");
  const result = await denoFS.exists(nonExistent);
  assertEquals(result, false);
});
