import { assertEquals, assertRejects } from "@std/assert";
import { calculateFileHash, verifyFileHash } from "./hash.ts";

Deno.test("calculateFileHash returns consistent hash for same content", async () => {
  // Create temporary file
  const tempFile = await Deno.makeTempFile();
  const testContent = "test content";
  await Deno.writeTextFile(tempFile, testContent);

  const hash1 = await calculateFileHash(tempFile);
  const hash2 = await calculateFileHash(tempFile);

  assertEquals(hash1, hash2);
  assertEquals(hash1.length, 64); // SHA-256 = 64 hex chars

  await Deno.remove(tempFile);
});

Deno.test("calculateFileHash returns different hash for different content", async () => {
  const tempFile1 = await Deno.makeTempFile();
  const tempFile2 = await Deno.makeTempFile();

  await Deno.writeTextFile(tempFile1, "content1");
  await Deno.writeTextFile(tempFile2, "content2");

  const hash1 = await calculateFileHash(tempFile1);
  const hash2 = await calculateFileHash(tempFile2);

  assertEquals(hash1 !== hash2, true);

  await Deno.remove(tempFile1);
  await Deno.remove(tempFile2);
});

Deno.test("verifyFileHash returns true for matching hash", async () => {
  const tempFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tempFile, "test");

  const hash = await calculateFileHash(tempFile);
  const isValid = await verifyFileHash(tempFile, hash);

  assertEquals(isValid, true);

  await Deno.remove(tempFile);
});

Deno.test("verifyFileHash returns false for non-matching hash", async () => {
  const tempFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tempFile, "test");

  const wrongHash = "0".repeat(64);
  const isValid = await verifyFileHash(tempFile, wrongHash);

  assertEquals(isValid, false);

  await Deno.remove(tempFile);
});

Deno.test("verifyFileHash throws error for non-existent file", async () => {
  await assertRejects(
    async () => {
      await verifyFileHash("/non/existent/file", "hash");
    },
    Deno.errors.NotFound,
  );
});

Deno.test("calculateFileHash handles empty files", async () => {
  const tempFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tempFile, "");

  const hash = await calculateFileHash(tempFile);

  assertEquals(hash.length, 64); // SHA-256 = 64 hex chars
  // SHA-256 hash of empty string
  assertEquals(
    hash,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );

  await Deno.remove(tempFile);
});
