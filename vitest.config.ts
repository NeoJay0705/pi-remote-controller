import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
    exclude: [
      "test/e2e/**",
      ".test-artifacts/**",
      "node_modules/**",
      "dist/**",
    ],
  },
});
