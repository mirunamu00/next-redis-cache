// Gate: every quarantined test names a tracking issue and a deadline that has not passed
// (flaky policy, ROADMAP.md section 6.6: fix or delete within 7 days).
//
// Recognized forms:
//   itQuarantine("#12 until 2026-10-06", ...)          (vitest, tests/support/quarantine.ts)
//   test("... @quarantine(#12 until 2026-10-06)", ...)  (Playwright title tag)
// Usage: node scripts/check-quarantine.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "./lib/run.mjs";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const MAX_DAYS = 7;
const { stdout } = run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "tests"], { shell: false, capture: true });
const files = stdout.split("\0").filter((f) => /\.(ts|mts|mjs|js)$/.test(f) && !f.endsWith("support/quarantine.ts"));
const today = new Date(new Date().toISOString().slice(0, 10));
const found = [];
const problems = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const re = /itQuarantine\(\s*["'`]([^"'`]*)["'`]|@quarantine\(([^)]*)\)/g;
  for (const m of text.matchAll(re)) {
    const ticket = (m[1] ?? m[2]).trim();
    const line = text.slice(0, m.index).split("\n").length;
    found.push(`${file}:${line} ${ticket}`);
    const parsed = /^#(\d+) until (\d{4}-\d{2}-\d{2})$/.exec(ticket);
    if (!parsed) {
      problems.push(`${file}:${line} quarantine note must be "#<issue> until YYYY-MM-DD", got "${ticket}"`);
      continue;
    }
    const until = new Date(parsed[2]);
    if (until < today) problems.push(`${file}:${line} quarantine deadline ${parsed[2]} has passed - fix or delete the test (issue #${parsed[1]})`);
    else if ((until - today) / 86_400_000 > MAX_DAYS) problems.push(`${file}:${line} quarantine deadline ${parsed[2]} is more than ${MAX_DAYS} days away`);
  }
}

for (const f of found) console.log(`[check-quarantine] quarantined: ${f}`);
if (problems.length > 0) {
  for (const p of problems) console.error(`[check-quarantine] ${p}`);
  process.exit(1);
}
console.log(`[check-quarantine] OK - ${found.length} quarantined test(s)`);
