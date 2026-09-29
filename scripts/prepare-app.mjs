// Assembles a test app for one Next.js variant and (optionally) builds it (ROADMAP.md section 6.2).
//
//   node scripts/prepare-app.mjs <app|all> [options]
//     --variant next-16.3        dependency set from test-apps/_variants (next-16.1 | next-16.3 | canary)
//     --pkg local                package under test: local (npm pack of this repo), npm:<version>, or a .tgz path
//     --no-pack                  with --pkg local: reuse .artifacts/nrc-local.tgz as is (CI downloads it)
//     --build A[,B]              next build once per build id; each result lands in builds/<id>/
//     --api v1                   NRC_API baked into the build (v1 now, v2 from P2)
//     --hot-dist                 copy the current dist/ into the installed package (and existing builds)
//                                instead of reinstalling - local fast iteration only, CI always uses tarballs
//
// Layout: .work/<app>@<variant>/ = variant package.json + lock, app sources, _shared/ (copied, never
// symlinked), node_modules/, builds/<id>/ (standalone server with .next/static, public/ and _shared/).
// Dependencies are reinstalled only when the lockfile changes; the package only when the tarball changes.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ensureTarball, tarballPath } from "./pack.mjs";
import { startOriginServer } from "./origin-server.mjs";
import { run } from "./lib/run.mjs";
import {
  APPS,
  DEFAULT_VARIANT,
  REPO_ROOT,
  TEST_APPS_DIR,
  appWorkDir,
  assertApp,
  assertVariant,
  buildDir,
  copyDir,
  exists,
  readJson,
  rmrf,
  sha256File,
  writeJson,
} from "./lib/work.mjs";

const PACKAGE_DIR = ["node_modules", "@mirunamu", "next-redis-cache"];
/** Entries in the work dir that belong to the assembly, not to the app sources. */
const KEEP = new Set(["node_modules", "builds", ".next", "package.json", "package-lock.json", ".nrc-deps.json", ".nrc-pkg.json"]);

const log = (msg) => console.log(`[prepare-app] ${msg}`);

function syncSources(app, dir) {
  for (const entry of exists(dir) ? readdirSync(dir) : []) if (!KEEP.has(entry)) rmrf(path.join(dir, entry));
  copyDir(path.join(TEST_APPS_DIR, app), dir);
  copyDir(path.join(TEST_APPS_DIR, "_shared"), path.join(dir, "_shared"));
}

export function installDependencies(variant, dir) {
  const variantDir = path.join(TEST_APPS_DIR, "_variants", variant);
  cpSync(path.join(variantDir, "package.json"), path.join(dir, "package.json"));
  const lock = path.join(variantDir, "package-lock.json");
  const hasLock = exists(lock);
  if (hasLock) cpSync(lock, path.join(dir, "package-lock.json"));
  else rmrf(path.join(dir, "package-lock.json"));

  const stampFile = path.join(dir, ".nrc-deps.json");
  const hash = sha256File(hasLock ? lock : path.join(variantDir, "package.json"));
  // Unlocked variants (canary) always reinstall so they track the latest release
  if (hasLock && readJson(stampFile, {}).hash === hash && exists(path.join(dir, "node_modules", "next"))) {
    log(`${variant}: dependencies up to date`);
    return false;
  }
  log(`${variant}: installing dependencies (${hasLock ? "npm ci" : "npm install, no lockfile"})`);
  rmrf(path.join(dir, "node_modules"));
  const args = hasLock ? ["ci"] : ["install", "--no-package-lock"];
  if (run("npm", [...args, "--no-audit", "--no-fund"], { cwd: dir }).status !== 0) throw new Error(`npm ${args[0]} failed in ${dir}`);
  writeJson(stampFile, { hash });
  rmrf(path.join(dir, ".nrc-pkg.json"));
  return true;
}

export function installPackage(pkgSpec, dir, { pack }) {
  let tgz;
  if (pkgSpec.endsWith(".tgz")) tgz = path.resolve(pkgSpec);
  else if (pkgSpec === "local" && !pack) {
    tgz = tarballPath("local");
    if (!exists(tgz)) throw new Error(`${tgz} is missing - run \`node scripts/pack.mjs\` or drop --no-pack`);
  } else tgz = ensureTarball(pkgSpec);
  const stampFile = path.join(dir, ".nrc-pkg.json");
  const hash = sha256File(tgz);
  if (readJson(stampFile, {}).hash === hash && exists(path.join(dir, ...PACKAGE_DIR, "package.json"))) {
    log(`package ${pkgSpec} already installed`);
    return;
  }
  log(`installing ${pkgSpec} from ${path.relative(REPO_ROOT, tgz)}`);
  // Relative path: npm treats it as a local tarball, and it never contains spaces from the checkout path
  const rel = path.relative(dir, tgz).split(path.sep).join("/");
  if (run("npm", ["install", "--no-save", "--no-audit", "--no-fund", rel], { cwd: dir }).status !== 0) {
    throw new Error(`installing ${tgz} failed`);
  }
  writeJson(stampFile, { hash, spec: pkgSpec });
}

/** Asserts that next and @redis/client each resolve to exactly one version (no duplicate instances). */
export function verifySingleInstances(dir) {
  const r = run("npm", ["ls", "next", "@redis/client", "--all", "--json"], { cwd: dir, capture: true });
  const tree = JSON.parse(r.stdout || "{}");
  const found = { next: new Set(), "@redis/client": new Set() };
  const visit = (deps) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      if (name in found && info.version) found[name].add(info.version);
      visit(info.dependencies);
    }
  };
  visit(tree.dependencies);
  const problems = [];
  for (const [name, versions] of Object.entries(found)) {
    if (versions.size !== 1) problems.push(`${name}: ${versions.size === 0 ? "missing" : [...versions].join(", ")}`);
  }
  const pkg = readJson(path.join(dir, ...PACKAGE_DIR, "package.json"));
  if (problems.length > 0) throw new Error(`npm ls: expected a single instance of each peer\n  ${problems.join("\n  ")}`);
  const summary = `next ${[...found.next][0]}, @redis/client ${[...found["@redis/client"]][0]}, ${pkg.name} ${pkg.version}`;
  log(`single instances OK: ${summary}`);
  return { next: [...found.next][0], redisClient: [...found["@redis/client"]][0], packageVersion: pkg.version };
}

function hotDist(dir) {
  const dist = path.join(REPO_ROOT, "dist");
  if (!exists(dist)) throw new Error("dist/ is missing - run `npm run build` first");
  // The installed files no longer match any tarball: the next regular run must reinstall
  rmrf(path.join(dir, ".nrc-pkg.json"));
  const targets = [path.join(dir, ...PACKAGE_DIR)];
  const builds = path.join(dir, "builds");
  if (exists(builds)) for (const b of readdirSync(builds)) targets.push(path.join(builds, b, ...PACKAGE_DIR));
  for (const t of targets.filter((t) => exists(t))) {
    rmrf(path.join(t, "dist"));
    copyDir(dist, path.join(t, "dist"));
    log(`hot-dist -> ${path.relative(REPO_ROOT, t)}`);
  }
}

async function build(app, variant, dir, buildId, { api }) {
  const origin = await startOriginServer();
  try {
    log(`${app}@${variant}: next build (BUILD_ID=${buildId}, NRC_API=${api})`);
    const started = Date.now();
    const env = {
      ...process.env,
      BUILD_ID: buildId,
      NRC_API: api,
      TEST_HOOKS: "1",
      ORIGIN_URL: origin.url,
      NEXT_TELEMETRY_DISABLED: "1",
      REDIS_URL: "",
    };
    // Asynchronous spawn: the origin server lives in this process and must keep answering during the build
    const child = spawn(process.execPath, [path.join("node_modules", "next", "dist", "bin", "next"), "build"], {
      cwd: dir,
      env,
      stdio: "inherit",
    });
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    if (status !== 0) throw new Error(`next build failed for ${app}@${variant} (exit ${status})`);
    log(`${app}@${variant}: built in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    await origin.close();
  }

  const out = buildDir(app, variant, buildId);
  rmrf(out);
  mkdirSync(path.dirname(out), { recursive: true });
  renameSync(path.join(dir, ".next", "standalone"), out);
  copyDir(path.join(dir, ".next", "static"), path.join(out, ".next", "static"));
  if (exists(path.join(dir, "public"))) copyDir(path.join(dir, "public"), path.join(out, "public"));
  // The handlers are traced by Next; copying them explicitly keeps the build independent of tracing (docs Dockerfile does the same)
  copyDir(path.join(dir, "_shared"), path.join(out, "_shared"));
  const meta = { app, variant, buildId, api, builtAt: new Date().toISOString(), ...verifySingleInstances(dir) };
  writeJson(path.join(out, "nrc-build.json"), meta);
  if (!exists(path.join(out, "server.js"))) throw new Error(`standalone server.js missing in ${out}`);
  if (process.platform === "win32") warmFiles(out);
  log(`${app}@${variant}: build ${buildId} ready at ${path.relative(REPO_ROOT, out)} (${Math.round(dirSize(out) / 1e6)} MB)`);
  return out;
}

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

/**
 * Reads every file of a fresh build once. On Windows the real-time antivirus scans each new file on
 * first open; for static-site (about 3,300 files) that took over 3 minutes and pushed the first server
 * start past the fleet readiness timeout. Paying it here keeps test timing independent of the scanner.
 * (Excluding .work/ from Defender makes this instant.)
 */
function warmFiles(dir) {
  const started = Date.now();
  let files = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        readFileSync(p);
        files++;
      }
    }
  };
  walk(dir);
  const ms = Date.now() - started;
  if (ms > 5000) log(`first read of ${files} new files took ${Math.round(ms / 1000)}s (antivirus scan?) - consider excluding .work/`);
}

/**
 * Programmatic entry point (also used by the e2e/chaos harness).
 * @param {{ app: string, variant?: string, pkg?: string, pack?: boolean, builds?: string[], api?: string, hotDist?: boolean }} o
 */
export async function prepareApp({ app, variant = DEFAULT_VARIANT, pkg = "local", pack = true, builds = [], api = "v1", hotDist: hot = false }) {
  assertApp(app);
  assertVariant(variant);
  const dir = appWorkDir(app, variant);
  syncSources(app, dir);
  installDependencies(variant, dir);
  if (hot) {
    if (!exists(path.join(dir, ...PACKAGE_DIR))) installPackage(pkg, dir, { pack });
    hotDist(dir);
  } else {
    installPackage(pkg, dir, { pack });
  }
  const info = verifySingleInstances(dir);
  const outs = [];
  for (const id of builds) outs.push(await build(app, variant, dir, id, { api }));
  return { dir, builds: outs, ...info };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      variant: { type: "string", default: DEFAULT_VARIANT },
      pkg: { type: "string", default: "local" },
      "no-pack": { type: "boolean", default: false },
      build: { type: "string" },
      api: { type: "string", default: "v1" },
      "hot-dist": { type: "boolean", default: false },
    },
  });
  const target = positionals[0];
  if (!target) {
    console.error("usage: node scripts/prepare-app.mjs <app|all> [--variant next-16.3] [--pkg local|npm:1.0.6|file.tgz] [--build A,B] [--api v1] [--hot-dist] [--no-pack]");
    process.exit(1);
  }
  const apps = target === "all" ? APPS : [target];
  const builds = values.build ? values.build.split(",").filter(Boolean) : [];
  let pack = !values["no-pack"];
  for (const app of apps) {
    await prepareApp({ app, variant: values.variant, pkg: values.pkg, pack, builds, api: values.api, hotDist: values["hot-dist"] });
    pack = false; // one pack per invocation is enough
  }
}
