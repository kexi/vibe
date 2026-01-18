import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000,
    globals: false,
    environment: "node",
  },
});
