/**
 * Deno environment implementation
 */

import type { Arch, OS, RuntimeBuild, RuntimeControl, RuntimeEnv } from "../types.ts";

export const denoEnv: RuntimeEnv = {
  get(key: string): string | undefined {
    return Deno.env.get(key);
  },

  set(key: string, value: string): void {
    Deno.env.set(key, value);
  },

  delete(key: string): void {
    Deno.env.delete(key);
  },

  toObject(): Record<string, string> {
    return Deno.env.toObject();
  },
};

/**
 * Map Deno OS to Runtime OS type.
 * Officially supported: darwin, linux, windows
 * Note: Unknown OSes fall back to linux (matches Node.js behavior).
 */
function mapOS(os: typeof Deno.build.os): OS {
  switch (os) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "windows":
      return "windows";
    default:
      return "linux";
  }
}

/**
 * Map Deno architecture to Runtime Arch type.
 * Officially supported: x86_64, aarch64, arm
 * Note: Unknown architectures fall back to x86_64 (matches Node.js behavior).
 *
 * The type assertion is needed because @types/deno may not include all
 * architectures that Deno supports at runtime.
 */
function mapArch(arch: string): Arch {
  switch (arch) {
    case "x86_64":
      return "x86_64";
    case "aarch64":
      return "aarch64";
    case "arm":
      return "arm";
    default:
      return "x86_64";
  }
}

export const denoBuild: RuntimeBuild = {
  os: mapOS(Deno.build.os),
  arch: mapArch(Deno.build.arch),
};

export const denoControl: RuntimeControl = {
  exit(code: number): never {
    Deno.exit(code);
  },

  chdir(path: string): void {
    Deno.chdir(path);
  },

  cwd(): string {
    return Deno.cwd();
  },

  execPath(): string {
    return Deno.execPath();
  },

  get args(): readonly string[] {
    return Deno.args;
  },
};
