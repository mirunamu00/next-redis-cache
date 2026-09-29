import { defineConfig } from "vitest/config";

// Test layers are split into vitest projects (ROADMAP.md section 6.5).
//   unit / property : pure logic, no network; runs on every PR, Windows included
//   fault           : mini-redis (in-process TCP server), no Docker; Windows included
//   fault-docker    : toxiproxy from docker/compose.yml (`npm run infra:up`); files named *.docker.test.ts
//   integration     : real Redis 7.2 / 8.4 through testcontainers; each file starts its own containers
//   contract        : differential oracle against Next's default "use cache" handler (mini-redis, no Docker)
//   chaos           : fleet of standalone test-app builds + docker compose Redis/toxiproxy (long-running)
// Flakiness is never hidden by retries (retry: 0). Unstable tests are fixed or quarantined (@quarantine).
const isCI = Boolean(process.env.CI);
// NRC_BLOB=<name> also writes a blob report (with coverage) to reports/blob/<name>.json; the CI coverage
// job merges the blobs of unit, integration and fault (vitest --merge-reports) into one report.
const blob = process.env.NRC_BLOB;
const reporters: Array<string | [string, Record<string, unknown>]> = ["default"];
if (isCI) reporters.push(["junit", { outputFile: "reports/junit.xml" }]);
// On GitHub Actions every failure also becomes a check-run annotation (file, line, test name, assertion
// message). Annotations are readable through the public API without auth, job logs are not.
if (process.env.GITHUB_ACTIONS) reporters.push("github-actions");
if (blob) reporters.push(["blob", { outputFile: `reports/blob/${blob}.json` }]);

export default defineConfig({
  test: {
    retry: 0,
    environment: "node",
    reporters,
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
      {
        extends: true,
        test: {
          name: "fault",
          include: ["tests/fault/**/*.test.ts"],
          exclude: ["tests/fault/**/*.docker.test.ts"],
          testTimeout: 15_000,
        },
      },
      {
        extends: true,
        test: {
          name: "fault-docker",
          include: ["tests/fault/**/*.docker.test.ts"],
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: "contract",
          include: ["tests/contract/oracle/**/*.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: "chaos",
          include: ["tests/chaos/**/*.test.ts"],
          // Fleets and Redis are shared resources: one file at a time, tests in order
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 240_000,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 30_000,
          // Container start includes a possible image pull on a cold machine
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
