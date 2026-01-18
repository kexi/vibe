import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "runtime/index": "src/runtime/index.ts",
    "types/config": "src/types/config.ts",
    "errors/index": "src/errors/index.ts",
    "context/index": "src/context/index.ts",
    "context/testing": "src/context/testing.ts",
  },
  format: ["esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "node18",
  external: ["zod"],
  esbuildOptions(options) {
    options.define = {
      "Deno": "undefined",
    };
  },
});
