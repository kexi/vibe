import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/core/src/**/*.test.ts", "packages/e2e/**/*.test.ts"],
    exclude: ["packages/core/src/runtime/deno/**"],
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000,
    globals: false,
    environment: "node",
  },
});
