// Mutation testing (ROADMAP.md section 6.5, weekly). Report-only until 2.0.0 (Q13): thresholds are
// shown in the report but `break` is null, so the run never fails on the score.
//
// Runner: the generic command runner executes the docker-free test set (vitest.mutation.config.ts)
// once per mutant. @stryker-mutator/vitest-runner 10.0.0 completes the dry run with vitest 5 but then
// reports 0 executed tests for every mutant (all "survived"), so it cannot be used yet.
// Without per-test coverage every mutant runs the whole set; --bail stops at the first failure.
/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "command",
  commandRunner: { command: "npx vitest run --config vitest.mutation.config.ts --bail 1 --reporter dot" },
  coverageAnalysis: "off",
  mutate: ["src/**/*.ts", "!src/types.ts", "!src/index.ts", "!src/use-cache.ts", "!src/instrumentation.ts", "!src/redis-entry.ts"],
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: { high: 80, low: 70, break: null },
  timeoutMS: 60_000,
  concurrency: 4,
  // The sandbox copy only needs sources, tests and configs
  ignorePatterns: [".work", ".artifacts", "test-results", "reports", "coverage", "test-apps", "docker", "dist", "playwright-report"],
  tempDirName: ".work/stryker-tmp",
  cleanTempDir: "always",
};
