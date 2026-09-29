// Appends the coverage summary to $GITHUB_STEP_SUMMARY (report-only until 2.0.0, decision Q13).
// Prints to stdout when not running in GitHub Actions. Missing coverage data is not an error.
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

// Always operate on the repository root, regardless of the caller's working directory.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const file = "coverage/coverage-summary.json";
if (!existsSync(file)) {
  console.log(`[coverage-summary] ${file} not found - skipped`);
  process.exit(0);
}

const total = JSON.parse(readFileSync(file, "utf8")).total;
const metrics = ["lines", "branches", "functions", "statements"].map((k) => `${k} ${total[k].pct}%`).join(" / ");
const text = `## Coverage (report-only until 2.0.0)\n\n${metrics}\n`;

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
else console.log(text);
