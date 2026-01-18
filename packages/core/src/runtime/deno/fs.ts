/**
 * Deno file system implementation
 */

import type { DirEntry, FileInfo, MkdirOptions, RemoveOptions, RuntimeFS } from "../types.ts";

function toFileInfo(stat: Deno.FileInfo): FileInfo {
  return {
    isFile: stat.isFile,
    isDirectory: stat.isDirectory,
    isSymlink: stat.isSymlink,
    size: stat.size,
    mtime: stat.mtime,
    atime: stat.atime,
    birthtime: stat.birthtime,
    mode: stat.mode,
  };
}

function toDirEntry(entry: Deno.DirEntry): DirEntry {
  return {
    name: entry.name,
    isFile: entry.isFile,
    isDirectory: entry.isDirectory,
    isSymlink: entry.isSymlink,
  };
}

export const denoFS: RuntimeFS = {
  readFile(path: string): Promise<Uint8Array> {
    return Deno.readFile(path);
  },

  readTextFile(path: string): Promise<string> {
    return Deno.readTextFile(path);
  },

  writeTextFile(path: string, content: string): Promise<void> {
    return Deno.writeTextFile(path, content);
  },

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await Deno.mkdir(path, options);
  },

  async remove(path: string, options?: RemoveOptions): Promise<void> {
    await Deno.remove(path, options);
  },

  async rename(src: string, dest: string): Promise<void> {
    await Deno.rename(src, dest);
  },

  async stat(path: string): Promise<FileInfo> {
    const stat = await Deno.stat(path);
    return toFileInfo(stat);
  },

  async lstat(path: string): Promise<FileInfo> {
    const stat = await Deno.lstat(path);
    return toFileInfo(stat);
  },

  async copyFile(src: string, dest: string): Promise<void> {
    await Deno.copyFile(src, dest);
  },

  async *readDir(path: string): AsyncIterable<DirEntry> {
    for await (const entry of Deno.readDir(path)) {
      yield toDirEntry(entry);
    }
  },

  makeTempDir(options?: { prefix?: string }): Promise<string> {
    return Deno.makeTempDir(options);
  },

  realPath(path: string): Promise<string> {
    return Deno.realPath(path);
  },

  async exists(path: string): Promise<boolean> {
    try {
      await Deno.stat(path);
      return true;
    } catch (error) {
      const isNotFound = error instanceof Deno.errors.NotFound;
      if (isNotFound) {
        return false;
      }
      throw error;
    }
  },
};
