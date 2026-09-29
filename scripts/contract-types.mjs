// contract-types layer (ROADMAP.md section 6.5): compiles tests/contract/types/*.contract.mts against the
// package tarball and each Next variant, as a consumer would see them, then runs the runtime contracts in
// tests/contract/runtime (the build-output fallback reads the fixture through that Next's FileSystemCache).
//
//   node scripts/contract-types.mjs [--variant next-16.3|next-16.1|canary|all] [--pkg local|npm:1.0.6|file.tgz] [--no-pack]
//
// Layout: .work/contract@<variant>/ holds the variant's dependencies plus the package; the contract
// sources are copied to contract/ inside it and compiled with the repository's TypeScript.
import path from "node:path";
import { parseArgs } from "node:util";
import { installDependencies, installPackage, verifySingleInstances } from "./prepare-app.mjs";
import { run } from "./lib/run.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readmeFiles } from "./lib/readme-blocks.mjs";
import { REPO_ROOT, VARIANTS, WORK_DIR, assertVariant, copyDir, rmrf, writeJson } from "./lib/work.mjs";

const { values } = parseArgs({
  options: {
    variant: { type: "string", default: "next-16.3" },
    pkg: { type: "string", default: "local" },
    "no-pack": { type: "boolean", default: false },
  },
});

/**
 * Type-checks the README's complete-file code blocks as a consumer project (bundler resolution like a
 * Next.js app, JS checked through checkJs). Node types come from the repository (the variants have none).
 */
function checkReadme(dir) {
  const files = readmeFiles(readFileSync(path.join(REPO_ROOT, "README.md"), "utf8"));
  if (files.length === 0) {
    console.error("[contract-types] README: no complete-file code blocks found");
    return 1;
  }
  const out = path.join(dir, "contract-readme");
  rmrf(out);
  for (const { file, code } of files) {
    mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    writeFileSync(path.join(out, file), code);
  }
  writeJson(path.join(out, "tsconfig.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2022", "DOM"],
      strict: true,
      allowJs: true,
      checkJs: true,
      noEmit: true,
      skipLibCheck: true,
      typeRoots: [path.join(REPO_ROOT, "node_modules", "@types")],
      types: ["node"],
    },
    include: files.map((f) => f.file),
  });
  console.log(`[contract-types] README: type-checking ${files.map((f) => f.file).join(", ")}`);
  return run(process.execPath, [tsc, "-p", path.join(out, "tsconfig.json")], { shell: false }).status;
}

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
  // Runtime contracts run from inside the install so that the package resolves this variant's next
  const runtime = path.join(dir, "contract-runtime");
  rmrf(runtime);
  copyDir(path.join(REPO_ROOT, "tests", "contract", "runtime"), runtime);
  const fixture = path.join(REPO_ROOT, "tests", "fixtures", "next-build", ".next", "server");
  const runtimeStatus = run(process.execPath, [path.join(runtime, "fallback.contract.mjs"), fixture], { shell: false, cwd: dir }).status;
  const readmeStatus = checkReadme(dir);
  results.push({
    variant,
    next: versions.next,
    ok: status === 0 && runtimeStatus === 0 && readmeStatus === 0,
    types: status === 0,
    runtime: runtimeStatus === 0,
    readme: readmeStatus === 0,
  });
}

console.log("\n[contract-types] summary");
for (const r of results) {
  const part = (name, ok) => `${name} ${ok ? "ok" : "FAIL"}`;
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.variant} (next ${r.next}, package ${values.pkg}; ${part("types", r.types)}, ${part("runtime", r.runtime)}, ${part("readme", r.readme)})`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
