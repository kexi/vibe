import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { calculateFileHash, verifyFileHash } from "./hash.ts";
import { setupRealTestContext } from "../context/testing.ts";

// Initialize test context with real runtime for filesystem tests
beforeAll(async () => {
  await setupRealTestContext();
});

describe("hash utilities", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("calculateFileHash", () => {
    it("returns consistent hash for same content", async () => {
      const tempFile = join(tempDir, "test1.txt");
      const testContent = "test content";
      await writeFile(tempFile, testContent);

      const hash1 = await calculateFileHash(tempFile);
      const hash2 = await calculateFileHash(tempFile);

      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // SHA-256 = 64 hex chars
    });

    it("returns different hash for different content", async () => {
      const tempFile1 = join(tempDir, "test1.txt");
      const tempFile2 = join(tempDir, "test2.txt");

      await writeFile(tempFile1, "content1");
      await writeFile(tempFile2, "content2");

      const hash1 = await calculateFileHash(tempFile1);
      const hash2 = await calculateFileHash(tempFile2);

      expect(hash1).not.toBe(hash2);
    });

    it("handles empty files", async () => {
      const tempFile = join(tempDir, "empty.txt");
      await writeFile(tempFile, "");

      const hash = await calculateFileHash(tempFile);

      expect(hash.length).toBe(64); // SHA-256 = 64 hex chars
      // SHA-256 hash of empty string
      expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });

    it("handles large files efficiently", async () => {
      const tempFile = join(tempDir, "large.txt");

      // Create a 1MB file
      const oneMB = 1024 * 1024;
      const content = "a".repeat(oneMB);
      await writeFile(tempFile, content);

      const start = performance.now();
      const hash = await calculateFileHash(tempFile);
      const elapsed = performance.now() - start;

      // Verify hash is calculated correctly
      expect(hash.length).toBe(64);
      expect(typeof hash).toBe("string");

      // Performance check: should complete within 1 second on modern hardware
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe("verifyFileHash", () => {
    it("returns true for matching hash", async () => {
      const tempFile = join(tempDir, "test.txt");
      await writeFile(tempFile, "test");

      const hash = await calculateFileHash(tempFile);
      const isValid = await verifyFileHash(tempFile, hash);

      expect(isValid).toBe(true);
    });

    it("returns false for non-matching hash", async () => {
      const tempFile = join(tempDir, "test.txt");
      await writeFile(tempFile, "test");

      const wrongHash = "0".repeat(64);
      const isValid = await verifyFileHash(tempFile, wrongHash);

      expect(isValid).toBe(false);
    });

    it("throws error for non-existent file", async () => {
      await expect(verifyFileHash("/non/existent/file", "hash")).rejects.toThrow();
    });
  });
});
