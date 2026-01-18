import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["../../main.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  minify: false,
  outDir: "dist",
  // External packages that should not be bundled
  external: [
    // Node.js built-in modules
    /^node:.*/,
    // Dependencies that are installed via npm
    "zod",
  ],
  // Include @jsr packages in bundle (not available on npm registry)
  noExternal: [/^@jsr\/.*/],
  // Handle .ts extension imports and map JSR imports to npm packages
  esbuildOptions(options) {
    options.resolveExtensions = [".ts", ".js", ".mjs", ".cjs"];
    // Map JSR imports to npm package names
    options.alias = {
      "@std/cli": "@jsr/std__cli",
      "@std/cli/parse-args": "@jsr/std__cli/parse-args",
      "@std/fs": "@jsr/std__fs",
      "@std/fs/expand-glob": "@jsr/std__fs/expand-glob",
      "@std/path": "@jsr/std__path",
      "@std/path/join": "@jsr/std__path/join",
      "@std/toml": "@jsr/std__toml",
      "@std/toml/parse": "@jsr/std__toml/parse",
      "@std/assert": "@jsr/std__assert",
    };
  },
  banner: {
    js: "// @ts-nocheck",
  },
});
