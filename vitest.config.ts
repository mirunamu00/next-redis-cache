import { defineConfig } from "vitest/config";

// Test layers are split into vitest projects (ROADMAP.md section 6.5).
//   unit / property     : no Docker needed; runs on every PR, Windows included
//   integration / fault : real Redis and fault injection; added in P0b
// Flakiness is never hidden by retries (retry: 0). Unstable tests are fixed or quarantined (@quarantine).
const isCI = Boolean(process.env.CI);

export default defineConfig({
  test: {
    retry: 0,
    environment: "node",
    reporters: isCI ? ["default", ["junit", { outputFile: "reports/junit.xml" }]] : ["default"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/types.ts"],
      reporter: ["text", "lcov", "html", "json-summary"],
      reportsDirectory: "coverage",
      // Thresholds become blocking from 2.0.0 (Q13). Until then coverage is report-only.
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "property",
          include: ["tests/property/**/*.test.ts"],
        },
      },
    ],
  },
});
