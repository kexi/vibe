import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/e2e/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000,
    globals: false,
    environment: "node",
  },
});
