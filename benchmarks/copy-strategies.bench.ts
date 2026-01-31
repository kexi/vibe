/**
 * Benchmark tests for copy strategies.
 *
 * Run with:
 *   deno bench benchmarks/copy-strategies.bench.ts --allow-read --allow-write --allow-run --allow-ffi
 */

import { join } from "@std/path";
import { CloneStrategy } from "../src/utils/copy/strategies/clone.ts";
import { NativeCloneStrategy } from "../src/utils/copy/strategies/native-clone.ts";
import { RsyncStrategy } from "../src/utils/copy/strategies/rsync.ts";
import { StandardStrategy } from "../src/utils/copy/strategies/standard.ts";
import { resetCapabilitiesCache } from "../src/utils/copy/detector.ts";

// Helper to create test files
async function createTestFiles(dir: string, count: number, sizeBytes: number): Promise<void> {
  const content = "x".repeat(sizeBytes);
  for (let i = 0; i < count; i++) {
    await Deno.writeTextFile(join(dir, `file_${i}.txt`), content);
  }
}

// Helper to create nested directory structure
async function createNestedDir(
  dir: string,
  depth: number,
  filesPerDir: number,
  fileSizeBytes: number,
): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await createTestFiles(dir, filesPerDir, fileSizeBytes);

  if (depth > 0) {
    for (let i = 0; i < 3; i++) {
      await createNestedDir(join(dir, `subdir_${i}`), depth - 1, filesPerDir, fileSizeBytes);
    }
  }
}

// Standard Strategy Benchmarks
const standardStrategy = new StandardStrategy();

Deno.bench({
  name: "Standard: copy 100 small files (1KB each)",
  group: "small-files",
  baseline: true,
  async fn() {
    const tempDir = await Deno.makeTempDir();
    const srcDir = join(tempDir, "src");
    const destDir = join(tempDir, "dest");

    await Deno.mkdir(srcDir);
    await createTestFiles(srcDir, 100, 1024);

    for (let i = 0; i < 100; i++) {
      await standardStrategy.copyFile(
        join(srcDir, `file_${i}.txt`),
        join(destDir, `file_${i}.txt`),
      );
    }

    await Deno.remove(tempDir, { recursive: true });
  },
});

Deno.bench({
  name: "Standard: copy directory (100 files, 1KB each)",
  group: "directory-copy",
  baseline: true,
  async fn() {
    const tempDir = await Deno.makeTempDir();
    const srcDir = join(tempDir, "src");
    const destDir = join(tempDir, "dest");

    await Deno.mkdir(srcDir);
    await createTestFiles(srcDir, 100, 1024);

    await standardStrategy.copyDirectory(srcDir, destDir);

    await Deno.remove(tempDir, { recursive: true });
  },
});

Deno.bench({
  name: "Standard: copy nested directory (3 levels, 10 files each)",
  group: "nested-directory",
  baseline: true,
  async fn() {
    const tempDir = await Deno.makeTempDir();
    const srcDir = join(tempDir, "src");
    const destDir = join(tempDir, "dest");

    await createNestedDir(srcDir, 2, 10, 1024);
    await standardStrategy.copyDirectory(srcDir, destDir);

    await Deno.remove(tempDir, { recursive: true });
  },
});

// Clone Strategy Benchmarks (macOS/Linux only) - uses cp -c / cp --reflink
const cloneStrategy = new CloneStrategy();
resetCapabilitiesCache();
const cloneAvailable = await cloneStrategy.isAvailable();

if (cloneAvailable) {
  Deno.bench({
    name: "Clone (cp -c): copy 100 small files (1KB each)",
    group: "small-files",
    async fn() {
      const tempDir = await Deno.makeTempDir();
      const srcDir = join(tempDir, "src");
      const destDir = join(tempDir, "dest");

      await Deno.mkdir(srcDir);
      await Deno.mkdir(destDir);
      await createTestFiles(srcDir, 100, 1024);

      for (let i = 0; i < 100; i++) {
        await cloneStrategy.copyFile(join(srcDir, `file_${i}.txt`), join(destDir, `file_${i}.txt`));
      }

      await Deno.remove(tempDir, { recursive: true });
    },
  });

  Deno.bench({
    name: "Clone (cp -c): copy directory (100 files, 1KB each)",
    group: "directory-copy",
    async fn() {
      const tempDir = await Deno.makeTempDir();
      const srcDir = join(tempDir, "src");
      const destDir = join(tempDir, "dest");

      await Deno.mkdir(srcDir);
      await createTestFiles(srcDir, 100, 1024);

      await cloneStrategy.copyDirectory(srcDir, destDir);

      await Deno.remove(tempDir, { recursive: true });
    },
  });

  Deno.bench({
    name: "Clone (cp -c): copy nested directory (3 levels, 10 files each)",
    group: "nested-directory",
    async fn() {
      const tempDir = await Deno.makeTempDir();
      const srcDir = join(tempDir, "src");
      const destDir = join(tempDir, "dest");

      await createNestedDir(srcDir, 2, 10, 1024);
      await cloneStrategy.copyDirectory(srcDir, destDir);

      await Deno.remove(tempDir, { recursive: true });
    },
  });
}

// Native Clone Strategy Benchmarks (macOS clonefile / Linux FICLONE)
const nativeCloneStrategy = new NativeCloneStrategy();
const nativeCloneAvailable = await nativeCloneStrategy.isAvailable();
const nativeSupportsDirectory = nativeCloneStrategy.supportsDirectoryClone();

if (nativeCloneAvailable) {
  Deno.bench({
    name: "NativeClone (clonefile FFI): copy 100 small files (1KB each)",
    group: "small-files",
    async fn() {
      const tempDir = await Deno.makeTempDir();
      const srcDir = join(tempDir, "src");
      const destDir = join(tempDir, "dest");

      await Deno.mkdir(srcDir);
      await Deno.mkdir(destDir);
      await createTestFiles(srcDir, 100, 1024);

      for (let i = 0; i < 100; i++) {
        await nativeCloneStrategy.copyFile(
          join(srcDir, `file_${i}.txt`),
          join(destDir, `file_${i}.txt`),
        );
      }

      await Deno.remove(tempDir, { recursive: true });
    },
  });

  if (nativeSupportsDirectory) {
    Deno.bench({
      name: "NativeClone (clonefile FFI): copy directory (100 files, 1KB each)",
      group: "directory-copy",
      async fn() {
        const tempDir = await Deno.makeTempDir();
        const srcDir = join(tempDir, "src");
        const destDir = join(tempDir, "dest");

        await Deno.mkdir(srcDir);
        await createTestFiles(srcDir, 100, 1024);

        await nativeCloneStrategy.copyDirectory(srcDir, destDir);

        await Deno.remove(tempDir, { recursive: true });
      },
    });

    Deno.bench({
      name: "NativeClone (clonefile FFI): copy nested directory (3 levels, 10 files each)",
      group: "nested-directory",
      async fn() {
        const tempDir = await Deno.makeTempDir();
        const srcDir = join(tempDir, "src");
        const destDir = join(tempDir, "dest");

        await createNestedDir(srcDir, 2, 10, 1024);
        await nativeCloneStrategy.copyDirectory(srcDir, destDir);

        await Deno.remove(tempDir, { recursive: true });
      },
    });
  }
}

// Rsync Strategy Benchmarks
const rsyncStrategy = new RsyncStrategy();
resetCapabilitiesCache();
const rsyncAvailable = await rsyncStrategy.isAvailable();

if (rsyncAvailable) {
  Deno.bench({
    name: "Rsync: copy 100 small files (1KB each)",
    group: "small-files",
    async fn() {
      const tempDir = await Deno.makeTempDir();
      const srcDir = join(tempDir, "src");
      const destDir = join(tempDir, "dest");

      await Deno.mkdir(srcDir);
      await Deno.mkdir(destDir);
      await createTestFiles(srcDir, 100, 1024);

      for (let i = 0; i < 100; i++) {
        await rsyncStrategy.copyFile(join(srcDir, `file_${i}.txt`), join(destDir, `file_${i}.txt`));
      }

      await Deno.remove(tempDir, { recursive: true });
    },
  });

  Deno.bench({
    name: "Rsync: copy directory (100 files, 1KB each)",
    group: "directory-copy",
    async fn() {
      const tempDir = await Deno.makeTempDir();
      const srcDir = join(tempDir, "src");
      const destDir = join(tempDir, "dest");

      await Deno.mkdir(srcDir);
      await Deno.mkdir(destDir);
      await createTestFiles(srcDir, 100, 1024);

      await rsyncStrategy.copyDirectory(srcDir, destDir);

      await Deno.remove(tempDir, { recursive: true });
    },
  });

  Deno.bench({
    name: "Rsync: copy nested directory (3 levels, 10 files each)",
    group: "nested-directory",
    async fn() {
      const tempDir = await Deno.makeTempDir();
      const srcDir = join(tempDir, "src");
      const destDir = join(tempDir, "dest");

      await Deno.mkdir(destDir);
      await createNestedDir(srcDir, 2, 10, 1024);
      await rsyncStrategy.copyDirectory(srcDir, destDir);

      await Deno.remove(tempDir, { recursive: true });
    },
  });
}

// Large file benchmarks
Deno.bench({
  name: "Standard: copy 10 large files (1MB each)",
  group: "large-files",
  baseline: true,
  async fn() {
    const tempDir = await Deno.makeTempDir();
    const srcDir = join(tempDir, "src");
    const destDir = join(tempDir, "dest");

    await Deno.mkdir(srcDir);
    await createTestFiles(srcDir, 10, 1024 * 1024);

    for (let i = 0; i < 10; i++) {
      await standardStrategy.copyFile(
        join(srcDir, `file_${i}.txt`),
        join(destDir, `file_${i}.txt`),
      );
    }

    await Deno.remove(tempDir, { recursive: true });
  },
});

if (cloneAvailable) {
  Deno.bench({
    name: "Clone (cp -c): copy 10 large files (1MB each)",
    group: "large-files",
    async fn() {
      const tempDir = await Deno.makeTempDir();
      const srcDir = join(tempDir, "src");
      const destDir = join(tempDir, "dest");

      await Deno.mkdir(srcDir);
      await Deno.mkdir(destDir);
      await createTestFiles(srcDir, 10, 1024 * 1024);

      for (let i = 0; i < 10; i++) {
        await cloneStrategy.copyFile(join(srcDir, `file_${i}.txt`), join(destDir, `file_${i}.txt`));
      }

      await Deno.remove(tempDir, { recursive: true });
    },
  });
}

if (nativeCloneAvailable) {
  Deno.bench({
    name: "NativeClone (clonefile FFI): copy 10 large files (1MB each)",
    group: "large-files",
    async fn() {
      const tempDir = await Deno.makeTempDir();
      const srcDir = join(tempDir, "src");
      const destDir = join(tempDir, "dest");

      await Deno.mkdir(srcDir);
      await Deno.mkdir(destDir);
      await createTestFiles(srcDir, 10, 1024 * 1024);

      for (let i = 0; i < 10; i++) {
        await nativeCloneStrategy.copyFile(
          join(srcDir, `file_${i}.txt`),
          join(destDir, `file_${i}.txt`),
        );
      }

      await Deno.remove(tempDir, { recursive: true });
    },
  });
}

if (rsyncAvailable) {
  Deno.bench({
    name: "Rsync: copy 10 large files (1MB each)",
    group: "large-files",
    async fn() {
      const tempDir = await Deno.makeTempDir();
      const srcDir = join(tempDir, "src");
      const destDir = join(tempDir, "dest");

      await Deno.mkdir(srcDir);
      await Deno.mkdir(destDir);
      await createTestFiles(srcDir, 10, 1024 * 1024);

      for (let i = 0; i < 10; i++) {
        await rsyncStrategy.copyFile(join(srcDir, `file_${i}.txt`), join(destDir, `file_${i}.txt`));
      }

      await Deno.remove(tempDir, { recursive: true });
    },
  });
}
