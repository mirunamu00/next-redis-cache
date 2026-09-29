// Publish isolation gate: fails if the `npm pack --dry-run` file list leaves the whitelist.
// Usage: npm run build && node scripts/check-pack.mjs
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { validatePackFiles } from "./lib/pack-rules.mjs";
import { run } from "./lib/run.mjs";

// Always operate on the repository root, regardless of the caller's working directory.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));

if (!existsSync("dist")) {
  console.error("[check-pack] dist/ is missing - run `npm run build` first");
  process.exit(1);
}

const { status, stdout, stderr } = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { capture: true });
if (status !== 0) {
  console.error("[check-pack] npm pack failed\n" + stderr);
  process.exit(1);
}

const files = JSON.parse(stdout)[0].files.map((f) => f.path.replace(/\\/g, "/"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const result = validatePackFiles(files, pkg);

if (!result.ok) {
  if (result.unexpected.length > 0) console.error("[check-pack] files that must not be published:\n  " + result.unexpected.join("\n  "));
  if (result.missing.length > 0) console.error("[check-pack] files missing from the tarball:\n  " + result.missing.join("\n  "));
  process.exit(1);
}

console.log(`[check-pack] OK - ${files.length} files, whitelist respected`);
