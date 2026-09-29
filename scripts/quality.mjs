// Packaging quality gate: runs publint, attw, size-limit, check-pack and check-no-hangul in order.
// Every step runs even if an earlier one fails; the gate fails if any step failed.
// Usage: npm run build && npm run quality
//
// Known exception (removed in ROADMAP.md section 7, P1):
//   attw false-esm - the exports "types" condition points at .d.ts unconditionally, so CJS (require)
//   consumers get ESM typings. Conditional types (.d.cts) are fixed in P1 (1.1.0). Until then only this
//   rule is ignored; everything else is checked.
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { run } from "./lib/run.mjs";

// Always operate on the repository root, regardless of the caller's working directory.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));

if (!existsSync("dist")) {
  console.error("[quality] dist/ is missing - run `npm run build` first");
  process.exit(1);
}

const steps = [
  ["publint", "npx", ["publint"]],
  ["attw", "npx", ["attw", "--pack", ".", "--profile", "node16", "--ignore-rules", "false-esm"]],
  ["size-limit", "npx", ["size-limit"]],
  ["check-pack", "node", ["scripts/check-pack.mjs"]],
  ["check-no-hangul", "node", ["scripts/check-no-hangul.mjs"]],
];

const results = [];
for (const [name, cmd, args] of steps) {
  console.log(`\n=== [quality] ${name} ===`);
  const { status } = run(cmd, args);
  results.push([name, status === 0]);
}

console.log("\n[quality] summary");
for (const [name, ok] of results) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
