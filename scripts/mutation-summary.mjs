// Mutation score per file from Stryker's JSON report (reports/mutation/mutation.json), written to
// $GITHUB_STEP_SUMMARY (or stdout). Report-only until 2.0.0 (Q13); the target is >= 70%.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const file = process.argv[2] ?? "reports/mutation/mutation.json";
if (!existsSync(file)) {
  console.error(`[mutation-summary] ${file} not found`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(file, "utf8"));
const DETECTED = new Set(["Killed", "Timeout"]);
const VALID = new Set(["Killed", "Timeout", "Survived", "NoCoverage"]);

const rows = [];
let detected = 0;
let valid = 0;
for (const [name, f] of Object.entries(report.files).sort()) {
  const ms = f.mutants.filter((m) => VALID.has(m.status));
  const d = ms.filter((m) => DETECTED.has(m.status)).length;
  detected += d;
  valid += ms.length;
  rows.push(`| ${name} | ${ms.length} | ${d} | ${ms.length ? ((d / ms.length) * 100).toFixed(1) : "-"}% |`);
}
const score = valid ? (detected / valid) * 100 : 0;
const md = [
  `### mutation score ${score.toFixed(1)}% (target 70%, blocking from 2.0.0)`,
  "",
  "| file | mutants | detected | score |",
  "|---|---|---|---|",
  ...rows,
  "",
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
console.log(md);
