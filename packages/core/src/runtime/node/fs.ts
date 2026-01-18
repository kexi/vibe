/**
 * Node.js file system implementation
 */

import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DirEntry, FileInfo, MkdirOptions, RemoveOptions, RuntimeFS } from "../types.ts";

function toFileInfo(stat: nodeFs.Stats): FileInfo {
  return {
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymlink: stat.isSymbolicLink(),
    size: stat.size,
    mtime: stat.mtime,
    atime: stat.atime,
    birthtime: stat.birthtime,
    mode: stat.mode,
  };
}

export const nodeFS: RuntimeFS = {
  async readFile(filePath: string): Promise<Uint8Array> {
    const buffer = await fs.readFile(filePath);
    return new Uint8Array(buffer);
  },

  async readTextFile(filePath: string): Promise<string> {
    return await fs.readFile(filePath, "utf-8");
  },

  async writeTextFile(filePath: string, content: string): Promise<void> {
    await fs.writeFile(filePath, content, "utf-8");
  },

  async mkdir(dirPath: string, options?: MkdirOptions): Promise<void> {
    await fs.mkdir(dirPath, {
      recursive: options?.recursive,
      mode: options?.mode,
    });
  },

  async remove(filePath: string, options?: RemoveOptions): Promise<void> {
    const stat = await fs.lstat(filePath).catch(() => null);
    const isDirectory = stat?.isDirectory() ?? false;

    if (isDirectory) {
      await fs.rm(filePath, { recursive: options?.recursive ?? false });
    } else {
      await fs.unlink(filePath);
    }
  },

  async rename(src: string, dest: string): Promise<void> {
    await fs.rename(src, dest);
  },

  async stat(filePath: string): Promise<FileInfo> {
    const stat = await fs.stat(filePath);
    return toFileInfo(stat);
  },

  async lstat(filePath: string): Promise<FileInfo> {
    const stat = await fs.lstat(filePath);
    return toFileInfo(stat);
  },

  async copyFile(src: string, dest: string): Promise<void> {
    await fs.copyFile(src, dest);
  },

  async *readDir(dirPath: string): AsyncIterable<DirEntry> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      yield {
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
      };
    }
  },

  async makeTempDir(options?: { prefix?: string }): Promise<string> {
    const prefix = options?.prefix ?? "tmp-";
    const tempDir = os.tmpdir();
    return await fs.mkdtemp(path.join(tempDir, prefix));
  },

  async realPath(filePath: string): Promise<string> {
    return await fs.realpath(filePath);
  },

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  },
};
