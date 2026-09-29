// perf layer (ROADMAP.md section 6.5, "perf gate"): measures a package build against Redis and compares
// with the committed baseline (tests/perf/baseline/<version>.json).
//
//   node scripts/perf.mjs [--variant next-16.3] [--redis url] [--check] [--update-baseline] [--time] [--out reports/perf.json]
//
// Deterministic metrics (hard gate with --check):
//   legacyHit.commandsPerRequest    Redis commands per cached static page (static-site /docs page)
//   useCacheHit.commandsPerRequest  Redis commands per request of a dynamic page whose "use cache" entry
//                                   is warm (full-cc /dyn/1); split by handler through the key layout
//   staticSiteBuild.memoryBytes     MEMORY USAGE of every key of one prewarmed static-site build
//   Gate: commands must not exceed the baseline, memory must stay within +5% (same Redis minor only).
// Timing metrics (--time, autocannon; nightly): p50/p99/req/s - reported, warning above +20%.
//
// Commands are attributed through MONITOR on a separate connection, filtered by this run's namespace,
// so nothing else on the server is counted. Requires: infra redis84 and builds of static-site and
// full-cc (node scripts/prepare-app.mjs <app> --build A).
import { appendFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@redis/client";
import { DEFAULT_REDIS_URL, startFleet } from "./fleet.mjs";
import { REPO_ROOT, appWorkDir, readJson, writeJson } from "./lib/work.mjs";

const { values } = parseArgs({
  options: {
    variant: { type: "string", default: process.env.NRC_NEXT_VARIANT ?? "next-16.3" },
    redis: { type: "string", default: DEFAULT_REDIS_URL },
    check: { type: "boolean", default: false },
    "update-baseline": { type: "boolean", default: false },
    time: { type: "boolean", default: false },
    out: { type: "string", default: "reports/perf.json" },
    requests: { type: "string", default: "20" },
  },
});
const N = Number(values.requests);
const BASELINE_DIR = path.join(REPO_ROOT, "tests", "perf", "baseline");
const log = (m) => console.log(`[perf] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Records every command that touches `namespace` (MONITOR on a dedicated connection). */
async function monitorNamespace(namespace) {
  const mon = createClient({ url: values.redis });
  mon.on("error", () => {});
  await mon.connect();
  const lines = [];
  await mon.monitor((line) => {
    if (String(line).includes(`"${namespace}:`)) lines.push(String(line));
  });
  return {
    reset: () => lines.splice(0),
    commands: () =>
      lines.map((l) => {
        const args = [...l.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
        return { cmd: args[0].toUpperCase(), key: args.find((a) => a.startsWith(`${namespace}:`)) ?? "" };
      }),
    close: () => mon.destroy(),
  };
}

async function get(fleet, p) {
  const res = await fleet.request(p);
  await res.arrayBuffer();
  if (res.status !== 200) throw new Error(`${p} answered ${res.status}`);
}

/** Which handler a key belongs to in the 1.x layout (v2 layouts are classified by their own segments). */
const classify = ({ key }) => {
  if (/:uc:|:u:/.test(key)) return "useCache";
  if (/:_(tags|tagTtls|revalidated|tagstate|builds)$/.test(key)) return "tagState";
  return "legacy";
};

function summarize(commands, requests) {
  const byCommand = {};
  const byHandler = {};
  for (const c of commands) {
    byCommand[c.cmd] = (byCommand[c.cmd] ?? 0) + 1;
    const h = classify(c);
    byHandler[h] = (byHandler[h] ?? 0) + 1;
  }
  const per = (n) => Math.round((n / requests) * 100) / 100;
  return {
    requests,
    commandsPerRequest: per(commands.length),
    byHandlerPerRequest: Object.fromEntries(Object.entries(byHandler).sort().map(([k, v]) => [k, per(v)])),
    byCommandPerRequest: Object.fromEntries(Object.entries(byCommand).sort().map(([k, v]) => [k, per(v)])),
  };
}

/** Warms `page`, then counts the commands of N more requests. */
async function commandsPerRequest(fleet, page) {
  await get(fleet, page);
  await get(fleet, page);
  const mon = await monitorNamespace(fleet.namespace);
  await sleep(200);
  mon.reset();
  for (let i = 0; i < N; i++) await get(fleet, page);
  await sleep(200);
  const summary = summarize(mon.commands(), N);
  await mon.close();
  return summary;
}

async function timingOf(fleet, p) {
  const { default: autocannon } = await import("autocannon");
  const r = await autocannon({ url: fleet.url + p, connections: 8, duration: 10 });
  return { path: p, p50: r.latency.p50, p99: r.latency.p99, requestsPerSec: r.requests.average, non2xx: r.non2xx };
}

async function staticSite(admin) {
  const fleet = await startFleet({ app: "static-site", variant: values.variant, instances: 1, redisUrl: values.redis, env: { NRC_PREWARM: "1" } });
  try {
    const page = "/docs/guide/doc-0";
    const legacyHit = await commandsPerRequest(fleet, page);
    let keys = 0;
    let memoryBytes = 0;
    for await (const batch of admin.scanIterator({ MATCH: `${fleet.namespace}:*`, COUNT: 500 })) {
      for (const key of batch) {
        keys += 1;
        memoryBytes += Number(await admin.memoryUsage(key, { SAMPLES: 0 })) || 0;
      }
    }
    return { legacyHit, staticSiteBuild: { keys, memoryBytes }, timing: values.time ? await timingOf(fleet, page) : undefined };
  } finally {
    await fleet.stop();
  }
}

async function fullCc() {
  const fleet = await startFleet({ app: "full-cc", variant: values.variant, instances: 1, redisUrl: values.redis });
  try {
    const page = "/dyn/1";
    const useCacheHit = await commandsPerRequest(fleet, page);
    return { useCacheHit, timing: values.time ? await timingOf(fleet, page) : undefined };
  } finally {
    await fleet.stop();
  }
}

function versionKey(file) {
  return file
    .replace(/\.json$/, "")
    .split(/[.-]/)
    .map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
}

/** Highest-version baseline file (e.g. 1.1.0.json over 1.0.6.json). */
function latestBaseline() {
  const files = readdirSync(BASELINE_DIR).filter((f) => f.endsWith(".json"));
  files.sort((a, b) => {
    const [x, y] = [versionKey(a), versionKey(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] !== y[i]) return (x[i] ?? -1) < (y[i] ?? -1) ? -1 : 1;
    }
    return 0;
  });
  return files.length ? path.join(BASELINE_DIR, files[files.length - 1]) : undefined;
}

function compare(report, base) {
  const problems = [];
  const warnings = [];
  for (const k of ["legacyHit", "useCacheHit"]) {
    const now = report.deterministic[k].commandsPerRequest;
    const was = base.deterministic[k].commandsPerRequest;
    if (now > was) problems.push(`${k}.commandsPerRequest ${now} > baseline ${was}`);
  }
  const mem = report.deterministic.staticSiteBuild.memoryBytes;
  const memBase = base.deterministic.staticSiteBuild.memoryBytes;
  const minor = (v) => String(v).split(".").slice(0, 2).join(".");
  if (minor(report.redis) !== minor(base.redis)) warnings.push(`memory not compared: Redis ${report.redis} differs from baseline ${base.redis}`);
  else if (mem > memBase * 1.05) problems.push(`staticSiteBuild.memoryBytes ${mem} > baseline ${memBase} +5%`);
  if (report.timing && base.timing) {
    for (const k of ["legacyHit", "useCacheHit"]) {
      if (report.timing[k].p99 > base.timing[k].p99 * 1.2) warnings.push(`${k} p99 ${report.timing[k].p99}ms > baseline ${base.timing[k].p99}ms +20%`);
    }
  }
  return { problems, warnings };
}

function stepSummary(report, base, file, { problems, warnings }) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const d = report.deterministic;
  const b = base.deterministic;
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      `### perf: package ${report.package}, Next ${report.next}, Redis ${report.redis} (baseline ${path.basename(file)})`,
      "",
      "| metric | now | baseline |",
      "|---|---|---|",
      `| legacy hit: commands/request | ${d.legacyHit.commandsPerRequest} | ${b.legacyHit.commandsPerRequest} |`,
      `| use-cache page: commands/request | ${d.useCacheHit.commandsPerRequest} | ${b.useCacheHit.commandsPerRequest} |`,
      `| static-site build: keys | ${d.staticSiteBuild.keys} | ${b.staticSiteBuild.keys} |`,
      `| static-site build: memory bytes | ${d.staticSiteBuild.memoryBytes} | ${b.staticSiteBuild.memoryBytes} |`,
      ...warnings.map((w) => `\n> WARN ${w}`),
      ...problems.map((p) => `\n> FAIL ${p}`),
      "",
    ].join("\n"),
  );
}

const admin = createClient({ url: values.redis });
admin.on("error", () => {});
await admin.connect();
const redisVersion = /redis_version:(\S+)/.exec(await admin.info("server"))?.[1];
const workDir = appWorkDir("static-site", values.variant);
const pkg = readJson(path.join(workDir, "node_modules", "@mirunamu", "next-redis-cache", "package.json"));
const next = readJson(path.join(workDir, "node_modules", "next", "package.json")).version;

log(`package ${pkg.version}, next ${next}, redis ${redisVersion}, ${N} requests per scenario`);
const ss = await staticSite(admin);
const cc = await fullCc();
admin.destroy();

const report = {
  package: pkg.version,
  next,
  redis: redisVersion,
  measuredAt: new Date().toISOString(),
  platform: `${process.platform} node ${process.version}`,
  deterministic: { legacyHit: ss.legacyHit, useCacheHit: cc.useCacheHit, staticSiteBuild: ss.staticSiteBuild },
  timing: values.time ? { legacyHit: ss.timing, useCacheHit: cc.timing } : undefined,
};
writeJson(path.join(REPO_ROOT, values.out), report);
console.log(JSON.stringify(report, null, 2));

if (values["update-baseline"]) {
  const file = path.join(BASELINE_DIR, `${pkg.version}.json`);
  writeJson(file, report);
  log(`baseline written: ${path.relative(REPO_ROOT, file)}`);
}

if (values.check) {
  const file = latestBaseline();
  if (!file) throw new Error("no baseline in tests/perf/baseline");
  const base = readJson(file);
  const result = compare(report, base);
  log(`compared with ${path.relative(REPO_ROOT, file)}`);
  for (const w of result.warnings) console.warn(`[perf] WARN ${w}`);
  for (const p of result.problems) console.error(`[perf] FAIL ${p}`);
  stepSummary(report, base, file, result);
  process.exit(result.problems.length ? 1 : 0);
}
