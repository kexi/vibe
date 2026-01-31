import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/core/src/**/*.test.ts"],
    exclude: ["packages/e2e/**"],
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000,
    globals: false,
    environment: "node",
  },
});
