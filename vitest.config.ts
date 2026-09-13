import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    /*
     * Fixtures are written to a temporary directory per test file, and the
     * content loader reads the real repository root unless told otherwise. A
     * single fork keeps the filesystem state predictable and matches how the
     * CLI is actually run.
     */
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
