// Mutation score per file from Stryker's JSON report (reports/mutation/mutation.json), written to
// $GITHUB_STEP_SUMMARY (or stdout). Blocking from 2.0.0 (Q13):
//
//   node scripts/mutation-summary.mjs [report]            summary only
//   node scripts/mutation-summary.mjs --check [report]    summary, exit 1 below MUTATION_BREAK (stryker.config.mjs)
//
// An unsharded `stryker run` breaks by itself (thresholds.break); the weekly CI job runs shards that do not,
// and gates the merged report with --check (ROADMAP.md D59).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { MUTATION_BREAK } from "../stryker.config.mjs";
import { mutationScore } from "./lib/mutation-shards.mjs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const file = args.find((a) => !a.startsWith("--")) ?? "reports/mutation/mutation.json";
if (!existsSync(file)) {
  console.error(`[mutation-summary] ${file} not found`);
  process.exit(1);
}
const { detected, valid, score, files } = mutationScore(JSON.parse(readFileSync(file, "utf8")));
const passed = valid > 0 && score >= MUTATION_BREAK;
const md = [
  `### mutation score ${score.toFixed(2)}% (${passed ? "passed" : "FAILED"}, break ${MUTATION_BREAK}%) - ${detected} of ${valid} mutants detected`,
  "",
  "| file | mutants | detected | score |",
  "|---|---|---|---|",
  ...files.map((f) => `| ${f.name} | ${f.valid} | ${f.detected} | ${f.score === null ? "-" : f.score.toFixed(1)}% |`),
  "",
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
console.log(md);
if (check && !passed) {
  console.error(`[mutation-summary] mutation score ${score.toFixed(2)}% is below the break threshold ${MUTATION_BREAK}%`);
  process.exit(1);
}
