// Merges the Stryker JSON reports of the weekly mutation shards (ROADMAP.md D59) into
// reports/mutation/mutation.json and reports/mutation/index.html. Fails when a file that stryker.config.mjs
// mutates is missing from the shard reports or appears twice; the score gate is mutation-summary.mjs --check.
//
//   node scripts/mutation-merge.mjs <directory with the shard reports>
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import stryker from "../stryker.config.mjs";
import { listFiles, mergeReports, selectFiles } from "./lib/mutation-shards.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = path.resolve(process.argv[2] ?? ".artifacts/mutation");

const found = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "mutation.json") found.push(p);
  }
};
if (existsSync(dir)) walk(dir);
console.log(`[mutation-merge] ${found.length} shard report(s) in ${path.relative(root, dir) || "."}`);

const expected = selectFiles(stryker.mutate, listFiles(root, "src"));
let merged;
try {
  merged = mergeReports(
    found.map((f) => JSON.parse(readFileSync(f, "utf8"))),
    expected,
  );
} catch (err) {
  console.error(`[mutation-merge] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const out = path.join(root, "reports", "mutation");
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "mutation.json"), JSON.stringify(merged));

// The same page Stryker's html reporter writes (mutation-testing-elements, a Stryker dependency)
try {
  const require = createRequire(import.meta.url);
  const script = readFileSync(require.resolve("mutation-testing-elements/dist/mutation-test-elements.js"), "utf8");
  const json = JSON.stringify(merged).replace(/</g, '<"+"');
  writeFileSync(
    path.join(out, "index.html"),
    `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><script>${script}</script></head><body>\n<mutation-test-report-app titlePostfix="Stryker (merged shards)"></mutation-test-report-app>\n<script>document.querySelector("mutation-test-report-app").report = ${json};</script>\n</body></html>\n`,
  );
} catch (err) {
  console.warn(`[mutation-merge] no html report (${err instanceof Error ? err.message : String(err)})`);
}
console.log(`[mutation-merge] ${Object.keys(merged.files).length} files merged into reports/mutation/mutation.json`);
