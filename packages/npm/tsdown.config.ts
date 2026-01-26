import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["../../main.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  dts: false,
  clean: true,
  sourcemap: true,
  treeshake: true,
  minify: false,
  outDir: "dist",
  external: [/^node:.*/, "zod", "@kexi/vibe-native"],
  noExternal: [/^@jsr\/.*/],
  outExtensions: () => ({
    js: ".js",
  }),
  inputOptions: {
    resolve: {
      alias: {
        "@std/cli": "@jsr/std__cli",
        "@std/cli/parse-args": "@jsr/std__cli/parse-args",
        "@std/fs": "@jsr/std__fs",
        "@std/fs/copy": "@jsr/std__fs/copy",
        "@std/fs/expand-glob": "@jsr/std__fs/expand-glob",
        "@std/path": "@jsr/std__path",
        "@std/path/join": "@jsr/std__path/join",
        "@std/toml": "@jsr/std__toml",
        "@std/toml/parse": "@jsr/std__toml/parse",
        "@std/assert": "@jsr/std__assert",
      },
    },
  },
  banner: {
    js: "// @ts-nocheck",
  },
});
