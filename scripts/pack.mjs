// Produces the package tarball that test apps install (ROADMAP.md section 6.2).
//
//   node scripts/pack.mjs               build + npm pack the working tree -> .artifacts/nrc-local.tgz
//   node scripts/pack.mjs --no-build    pack the existing dist/ (CI builds once in the setup job)
//   node scripts/pack.mjs npm:1.0.6     fetch a published version -> .artifacts/nrc-npm-1.0.6.tgz
//
// Test apps never link the repository (no workspaces, no npm link): they install this tarball, so they
// see exactly what npm users get (exports, files, ESM/CJS) and resolve next/@redis/client themselves.
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./lib/run.mjs";
import { ARTIFACTS_DIR, REPO_ROOT, exists, rmrf } from "./lib/work.mjs";

const PACKAGE_NAME = "@mirunamu/next-redis-cache";

/** Tarball path for a package spec: "local" or "npm:<version>". */
export function tarballPath(spec) {
  if (spec === "local") return path.join(ARTIFACTS_DIR, "nrc-local.tgz");
  const m = /^npm:(.+)$/.exec(spec);
  if (!m) throw new Error(`package spec must be "local" or "npm:<version>", got "${spec}"`);
  return path.join(ARTIFACTS_DIR, `nrc-npm-${m[1]}.tgz`);
}

/** Moves the single *.tgz npm pack wrote into `tmp` to `target`. */
function adoptTarball(tmp, target) {
  const produced = readdirSync(tmp).filter((f) => f.endsWith(".tgz"));
  if (produced.length !== 1) throw new Error(`expected one tarball in ${tmp}, found: ${produced.join(", ") || "none"}`);
  rmrf(target);
  renameSync(path.join(tmp, produced[0]), target);
  rmrf(tmp);
}

/**
 * Creates (or reuses, for published versions) the tarball for `spec` and returns its absolute path.
 * @param {string} spec "local" | "npm:<version>"
 * @param {{ build?: boolean }} [opts]
 */
export function ensureTarball(spec, { build = true } = {}) {
  const target = tarballPath(spec);
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const tmp = path.join(ARTIFACTS_DIR, `tmp-${process.pid}`);
  rmrf(tmp);
  mkdirSync(tmp, { recursive: true });

  if (spec === "local") {
    if (build && run("npm", ["run", "build"], { cwd: REPO_ROOT }).status !== 0) throw new Error("npm run build failed");
    if (!exists(path.join(REPO_ROOT, "dist"))) throw new Error("dist/ is missing - run `npm run build` first");
    const r = run("npm", ["pack", "--pack-destination", tmp, "--ignore-scripts"], { cwd: REPO_ROOT, capture: true });
    if (r.status !== 0) throw new Error(`npm pack failed\n${r.stderr}`);
  } else {
    if (exists(target)) {
      rmrf(tmp);
      return target; // published tarballs are immutable
    }
    const version = spec.slice("npm:".length);
    const r = run("npm", ["pack", `${PACKAGE_NAME}@${version}`, "--pack-destination", tmp], { cwd: REPO_ROOT, capture: true });
    if (r.status !== 0) throw new Error(`npm pack ${PACKAGE_NAME}@${version} failed\n${r.stderr}`);
  }
  adoptTarball(tmp, target);
  return target;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const spec = args.find((a) => !a.startsWith("--")) ?? "local";
  const file = ensureTarball(spec, { build: !args.includes("--no-build") });
  console.log(`[pack] ${spec} -> ${path.relative(REPO_ROOT, file)}`);
}
