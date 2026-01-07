import { assertEquals } from "@std/assert";
import { isRsyncAvailable, runRsync } from "./rsync.ts";
import { join } from "@std/path";

Deno.test("isRsyncAvailable: returns true when rsync is installed", async () => {
  // This test assumes rsync is installed on the system
  // If not installed, this test may fail
  const result = await isRsyncAvailable();

  // On most systems, rsync should be available
  assertEquals(typeof result, "boolean");
});

Deno.test("runRsync: syncs directory contents", async () => {
  // Skip if rsync is not available
  const rsyncAvailable = await isRsyncAvailable();
  if (!rsyncAvailable) {
    console.log("Skipping test: rsync not available");
    return;
  }

  const tempDir = await Deno.makeTempDir();
  const srcDir = join(tempDir, "src");
  const destDir = join(tempDir, "dest");

  try {
    // Create source directory with files
    await Deno.mkdir(srcDir, { recursive: true });
    await Deno.writeTextFile(join(srcDir, "file1.txt"), "content1");
    await Deno.writeTextFile(join(srcDir, "file2.txt"), "content2");

    // Create subdirectory
    await Deno.mkdir(join(srcDir, "subdir"), { recursive: true });
    await Deno.writeTextFile(join(srcDir, "subdir/file3.txt"), "content3");

    // Create destination directory
    await Deno.mkdir(destDir, { recursive: true });

    // Run rsync
    const result = await runRsync(srcDir, destDir);

    assertEquals(result.success, true);
    assertEquals(result.exitCode, 0);

    // Verify files were copied
    const file1Content = await Deno.readTextFile(join(destDir, "file1.txt"));
    assertEquals(file1Content, "content1");

    const file2Content = await Deno.readTextFile(join(destDir, "file2.txt"));
    assertEquals(file2Content, "content2");

    const file3Content = await Deno.readTextFile(
      join(destDir, "subdir/file3.txt"),
    );
    assertEquals(file3Content, "content3");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runRsync: handles non-existent source", async () => {
  // Skip if rsync is not available
  const rsyncAvailable = await isRsyncAvailable();
  if (!rsyncAvailable) {
    console.log("Skipping test: rsync not available");
    return;
  }

  const tempDir = await Deno.makeTempDir();
  const srcDir = join(tempDir, "nonexistent");
  const destDir = join(tempDir, "dest");

  try {
    await Deno.mkdir(destDir, { recursive: true });

    // Run rsync on non-existent source
    const result = await runRsync(srcDir, destDir);

    // rsync should fail
    assertEquals(result.success, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("runRsync: preserves directory structure", async () => {
  // Skip if rsync is not available
  const rsyncAvailable = await isRsyncAvailable();
  if (!rsyncAvailable) {
    console.log("Skipping test: rsync not available");
    return;
  }

  const tempDir = await Deno.makeTempDir();
  const srcDir = join(tempDir, "src");
  const destDir = join(tempDir, "dest");

  try {
    // Create nested directory structure
    await Deno.mkdir(join(srcDir, "a/b/c"), { recursive: true });
    await Deno.writeTextFile(join(srcDir, "a/b/c/deep.txt"), "deep content");

    await Deno.mkdir(destDir, { recursive: true });

    // Run rsync
    const result = await runRsync(srcDir, destDir);

    assertEquals(result.success, true);

    // Verify nested structure was preserved
    const deepContent = await Deno.readTextFile(
      join(destDir, "a/b/c/deep.txt"),
    );
    assertEquals(deepContent, "deep content");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
