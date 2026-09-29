// Gate: fails if any non-Markdown file in the repository contains Hangul.
// Scans tracked files plus untracked files that are not ignored, so new files are caught before commit.
// Usage: node scripts/check-no-hangul.mjs
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { findHangulLines, isChecked } from "./lib/hangul-rules.mjs";
import { run } from "./lib/run.mjs";

// Always operate on the repository root, regardless of the caller's working directory.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const { status, stdout, stderr } = run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  shell: false,
  capture: true,
});
if (status !== 0) {
  console.error("[check-no-hangul] git ls-files failed\n" + stderr);
  process.exit(1);
}

const files = [...new Set(stdout.split("\0").filter(Boolean))].filter(isChecked).sort();
const offenders = [];

for (const file of files) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    continue; // deleted in the working tree but still in the index
  }
  if (buf.includes(0)) continue; // binary
  const hits = findHangulLines(buf.toString("utf8"));
  if (hits.length > 0) offenders.push({ file, hits });
}

if (offenders.length > 0) {
  console.error("[check-no-hangul] Hangul found in non-Markdown files (code must be English-only):");
  for (const { file, hits } of offenders) {
    for (const h of hits.slice(0, 5)) console.error(`  ${file}:${h.line}: ${h.text.slice(0, 120)}`);
    if (hits.length > 5) console.error(`  ${file}: ... ${hits.length - 5} more line(s)`);
  }
  process.exit(1);
}

console.log(`[check-no-hangul] OK - ${files.length} files checked`);
