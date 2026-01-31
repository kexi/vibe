import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 60000,
    teardownTimeout: 60000,
    globals: false,
    environment: "node",
  },
});
