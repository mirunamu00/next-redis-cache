// contract-types layer (ROADMAP.md section 6.5): compiles tests/contract/types/*.contract.mts against the
// package tarball and each Next variant, as a consumer would see them. Nothing is executed.
//
//   node scripts/contract-types.mjs [--variant next-16.3|next-16.1|canary|all] [--pkg local|npm:1.0.6|file.tgz] [--no-pack]
//
// Layout: .work/contract@<variant>/ holds the variant's dependencies plus the package; the contract
// sources are copied to contract/ inside it and compiled with the repository's TypeScript.
import path from "node:path";
import { parseArgs } from "node:util";
import { installDependencies, installPackage, verifySingleInstances } from "./prepare-app.mjs";
import { run } from "./lib/run.mjs";
import { REPO_ROOT, VARIANTS, WORK_DIR, assertVariant, copyDir, rmrf } from "./lib/work.mjs";

const { values } = parseArgs({
  options: {
    variant: { type: "string", default: "next-16.3" },
    pkg: { type: "string", default: "local" },
    "no-pack": { type: "boolean", default: false },
  },
});

const variants = values.variant === "all" ? VARIANTS.filter((v) => v !== "canary") : values.variant.split(",");
const tsc = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const results = [];
let pack = !values["no-pack"];

for (const variant of variants) {
  assertVariant(variant);
  const dir = path.join(WORK_DIR, `contract@${variant}`);
  console.log(`\n=== [contract-types] ${variant} (${values.pkg}) ===`);
  installDependencies(variant, dir);
  installPackage(values.pkg, dir, { pack });
  pack = false;
  const versions = verifySingleInstances(dir);
  const src = path.join(dir, "contract");
  rmrf(src);
  copyDir(path.join(REPO_ROOT, "tests", "contract", "types"), src);
  const { status } = run(process.execPath, [tsc, "-p", path.join(src, "tsconfig.json")], { shell: false });
  results.push({ variant, next: versions.next, ok: status === 0 });
}

console.log("\n[contract-types] summary");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.variant} (next ${r.next}, package ${values.pkg})`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
