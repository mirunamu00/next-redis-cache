// Mutation testing (ROADMAP.md section 6.5, weekly). Blocking from 2.0.0 (Q13): a score below `break`
// (70%) makes `stryker run` exit 1, which fails the weekly nightly job and files the nightly-failure issue.
//
// Runner: the generic command runner executes the docker-free test set (vitest.mutation.config.ts)
// once per mutant. @stryker-mutator/vitest-runner 10.0.0 completes the dry run with vitest 5 but then
// reports 0 executed tests for every mutant (all "survived"), so it cannot be used yet.
// Without per-test coverage every mutant runs the whole set; --bail stops at the first failure.
//
// The weekly CI job runs this config in parallel shards (`--mutate` from scripts/mutation-shard.mjs, D59) with
// NRC_MUTATION_SHARD set: a shard never breaks on the score of its own files, the merged report of all shards is
// gated instead (scripts/mutation-merge.mjs, then mutation-summary.mjs --check against MUTATION_BREAK).

/** Lowest acceptable mutation score in percent (Q13). */
export const MUTATION_BREAK = 70;

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "command",
  commandRunner: { command: "npx vitest run --config vitest.mutation.config.ts --bail 1 --reporter dot" },
  coverageAnalysis: "off",
  mutate: ["src/**/*.ts", "!src/types.ts", "!src/index.ts", "!src/use-cache.ts", "!src/instrumentation.ts", "!src/redis-entry.ts"],
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: { high: 80, low: 70, break: process.env.NRC_MUTATION_SHARD ? null : MUTATION_BREAK },
  timeoutMS: 60_000,
  concurrency: 4,
  // The sandbox copy only needs sources, tests and configs
  ignorePatterns: [".work", ".artifacts", "test-results", "reports", "coverage", "test-apps", "docker", "dist", "playwright-report", "!tests/fixtures/next-build/.next/**"],
  tempDirName: ".work/stryker-tmp",
  cleanTempDir: "always",
};
