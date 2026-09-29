// Coverage summary and gate (ROADMAP.md section 6.6, decision Q13: blocking from 2.0.0).
//
//   node scripts/coverage-summary.mjs            summary only (the unit job: docker-free layers, not gated)
//   node scripts/coverage-summary.mjs --check    summary + thresholds (scripts/lib/coverage-rules.mjs),
//                                                exit 1 below any of them or without a report
//
// The ci `coverage` job runs --check on the merged report of every layer; that job is part of the gate.
// The summary goes to $GITHUB_STEP_SUMMARY on GitHub Actions and to stdout.
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { coverageFailures, PER_FILE_LINES, THRESHOLDS } from "./lib/coverage-rules.mjs";

// Always operate on the repository root, regardless of the caller's working directory.
const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);

const check = process.argv.includes("--check");
const file = process.env.NRC_COVERAGE_SUMMARY ?? "coverage/coverage-summary.json";
if (!existsSync(file)) {
  if (check) {
    console.error(`[coverage-summary] ${file} not found - the coverage gate cannot pass without a report`);
    process.exit(1);
  }
  console.log(`[coverage-summary] ${file} not found - skipped`);
  process.exit(0);
}

const relative = (f) => (path.isAbsolute(f) ? path.relative(root, f) : f).split(path.sep).join("/");
const summary = JSON.parse(readFileSync(file, "utf8"));
const failures = coverageFailures(summary, relative);
const total = summary.total ?? {};

const metrics = ["lines", "branches", "functions", "statements"].map((k) => `${k} ${total[k]?.pct}%`).join(" / ");
const limits = `Thresholds: lines ${THRESHOLDS.lines} / branches ${THRESHOLDS.branches} / functions ${THRESHOLDS.functions}, every file lines >= ${PER_FILE_LINES}.`;
const rows = Object.entries(summary)
  .filter(([f]) => f !== "total")
  .map(([f, m]) => [relative(f), m])
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([f, m]) => `| ${f} | ${m.lines?.pct}% | ${m.branches?.pct}% | ${m.functions?.pct}% |`);
const status = check ? (failures.length ? "FAILED" : "passed") : "not gated";
const text = [
  `## Coverage (${status})`,
  "",
  metrics,
  "",
  limits,
  "",
  ...(check && failures.length ? ["Below threshold:", "", ...failures.map((f) => `- ${f}`), ""] : []),
  "<details><summary>per file</summary>",
  "",
  "| file | lines | branches | functions |",
  "|---|---|---|---|",
  ...rows,
  "",
  "</details>",
  "",
].join("\n");

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
console.log(text);
if (check && failures.length) {
  for (const f of failures) console.error(`[coverage-summary] below threshold: ${f}`);
  process.exit(1);
}
