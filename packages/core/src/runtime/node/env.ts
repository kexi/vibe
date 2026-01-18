/**
 * Node.js environment implementation
 */

import * as os from "node:os";
import type { Arch, OS, RuntimeBuild, RuntimeControl, RuntimeEnv } from "../types.ts";

export const nodeEnv: RuntimeEnv = {
  get(key: string): string | undefined {
    return process.env[key];
  },

  set(key: string, value: string): void {
    process.env[key] = value;
  },

  delete(key: string): void {
    delete process.env[key];
  },

  toObject(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  },
};

function mapPlatform(platform: NodeJS.Platform): OS {
  switch (platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

function mapArch(arch: NodeJS.Architecture): Arch {
  switch (arch) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "aarch64";
    case "arm":
      return "arm";
    default:
      return "x86_64";
  }
}

export const nodeBuild: RuntimeBuild = {
  os: mapPlatform(os.platform()),
  arch: mapArch(os.arch() as NodeJS.Architecture),
};

export const nodeControl: RuntimeControl = {
  exit(code: number): never {
    process.exit(code);
  },

  chdir(path: string): void {
    process.chdir(path);
  },

  cwd(): string {
    return process.cwd();
  },

  execPath(): string {
    return process.execPath;
  },

  get args(): readonly string[] {
    // Skip first two arguments (node and script path)
    return process.argv.slice(2);
  },
};
