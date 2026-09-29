// Writes a Markdown summary of JUnit reports (vitest, Playwright) to $GITHUB_STEP_SUMMARY, or stdout
// when run locally. No external service (Q16): reports stay in artifacts, the summary on the run page.
//
//   node scripts/junit-summary.mjs "<title>" reports/junit.xml [more.xml ...]
// Missing files are listed as "no report" (the job may have failed before the tests ran).
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const [title = "tests", ...files] = process.argv.slice(2);

const attr = (tag, name) => Number(new RegExp(`\\b${name}="(\\d+(?:\\.\\d+)?)"`).exec(tag)?.[1] ?? 0);

const rows = [];
const failed = [];
for (const file of files) {
  if (!existsSync(file)) {
    rows.push(`| ${file} | no report | | | | |`);
    continue;
  }
  const xml = readFileSync(file, "utf8");
  const root = /<testsuites\b[^>]*>/.exec(xml)?.[0] ?? /<testsuite\b[^>]*>/.exec(xml)?.[0] ?? "";
  const tests = attr(root, "tests");
  const failures = attr(root, "failures") + attr(root, "errors");
  const skipped = attr(root, "skipped");
  const time = attr(root, "time");
  rows.push(`| ${file} | ${tests} | ${tests - failures - skipped} | ${failures} | ${skipped} | ${time.toFixed(1)}s |`);
  for (const m of xml.matchAll(/<testcase\b[^>]*name="([^"]*)"[^>]*classname="([^"]*)"[^>]*>(?:(?!<\/testcase>)[\s\S])*?<(failure|error)\b/g)) {
    if (failed.length < 30) failed.push(`- ${m[2]} > ${m[1]}`);
  }
}

const md = [
  `### ${title}`,
  "",
  "| report | tests | passed | failed | skipped | time |",
  "|---|---|---|---|---|---|",
  ...rows,
  ...(failed.length ? ["", "Failed:", ...failed] : []),
  "",
].join("\n");

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
else console.log(md);
