import { defineConfig } from "vitest/config";

// Test set for mutation testing (stryker.config.mjs): every layer that needs no Docker - unit, property,
// contract oracle and the mini-redis fault tests. A flat config (no projects) keeps the Stryker vitest
// runner simple. Integration/chaos need containers and are too slow to run once per mutant.
export default defineConfig({
  test: {
    retry: 0,
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/property/**/*.test.ts", "tests/contract/oracle/**/*.test.ts", "tests/fault/**/*.test.ts"],
    exclude: ["tests/fault/**/*.docker.test.ts"],
    testTimeout: 15_000,
  },
});
