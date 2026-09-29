import { defineConfig } from "@playwright/test";

// e2e layer (ROADMAP.md section 6.5): Playwright against a 2-instance fleet (scripts/fleet.mjs) of a
// standalone test-app build. Build first: `node scripts/prepare-app.mjs <app> --build A`.
//
//   NRC_NEXT_VARIANT  next-16.3 (default) | next-16.1 | canary
//   NRC_E2E_REDIS     redis84 (default) | redis72 - which compose service the fleet uses
//   NRC_QUARANTINE    "only" runs @quarantine tests (nightly repeat); otherwise they are excluded
//
// Flakiness is never retried away (retries: 0). One worker: each project owns one fleet and the
// tests inside a project share its Redis namespace.
const isCI = Boolean(process.env.CI);
const quarantineOnly = process.env.NRC_QUARANTINE === "only";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: isCI,
  grep: quarantineOnly ? /@quarantine/ : undefined,
  grepInvert: quarantineOnly ? undefined : /@quarantine/,
  outputDir: "test-results/e2e",
  // "github" turns failures into check-run annotations (public API, no auth needed - unlike job logs)
  reporter: isCI
    ? [
        ["list"],
        ["html", { open: "never", outputFolder: "reports/playwright" }],
        ["junit", { outputFile: "reports/e2e-junit.xml" }],
        ...(process.env.GITHUB_ACTIONS ? ([["github"]] as const) : []),
      ]
    : [["list"]],
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "static-site", testDir: "tests/e2e/static-site" },
    { name: "full-legacy", testDir: "tests/e2e/full-legacy" },
    { name: "full-cc", testDir: "tests/e2e/full-cc" },
  ],
});
