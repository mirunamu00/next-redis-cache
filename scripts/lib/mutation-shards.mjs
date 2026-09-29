// Mutation test shards (ROADMAP.md section 6.8, D59). Shared by scripts/mutation-shard.mjs, scripts/mutation-merge.mjs
// and their unit test.
//
// The weekly job runs Stryker once per shard in parallel jobs, each shard mutating a disjoint set of the files
// that stryker.config.mjs `mutate` selects; the merge job puts the reports back together, checks that every file
// is in exactly one shard report and gates the score of the whole (mutation-summary.mjs --check).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** A glob of the `mutate` option as a RegExp (supports `**`, `*` and `?`; paths use "/"). */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" matches any number of directories, "**" at the end anything
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Files (relative, "/"-separated) selected by Stryker-style `mutate` patterns ("!" excludes). */
export function selectFiles(patterns, files) {
  const include = patterns.filter((p) => !p.startsWith("!")).map(globToRegExp);
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => globToRegExp(p.slice(1)));
  return files.filter((f) => include.some((r) => r.test(f)) && !exclude.some((r) => r.test(f))).sort();
}

/** Every file below `dir` (relative to `root`, "/"-separated). */
export function listFiles(root, dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(path.join(root, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk(dir);
  return out;
}

/** Rough mutant count of a source: its size without comments and blank space. */
export function weightOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/\s+/g, "").length;
}

/**
 * Splits weighted files into `count` shards: heaviest first, each to the lightest shard so far (ties by
 * index), so the plan is deterministic for a given source tree. Returns the shards' files, sorted.
 * @param {{ file: string, weight: number }[]} weighted
 * @param {number} count
 * @returns {string[][]}
 */
export function planShards(weighted, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be a positive integer, got ${count}`);
  const shards = Array.from({ length: count }, () => ({ files: [], weight: 0 }));
  const order = [...weighted].sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  for (const { file, weight } of order) {
    let lightest = shards[0];
    for (const s of shards) if (s.weight < lightest.weight) lightest = s;
    lightest.files.push(file);
    lightest.weight += weight;
  }
  return shards.map((s) => s.files.sort());
}

/**
 * The files of stryker.config.mjs `mutate` in `root` with their weights.
 * @param {string} root
 * @param {string[]} patterns
 * @returns {{ file: string, weight: number }[]}
 */
export function mutateTargets(root, patterns) {
  const files = selectFiles(patterns, listFiles(root, "src"));
  return files.map((file) => ({ file, weight: weightOf(readFileSync(path.join(root, file), "utf8")) }));
}

/** Parses "i/n" (1-based). */
export function parseShard(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(String(spec ?? ""));
  const index = m ? Number(m[1]) : NaN;
  const count = m ? Number(m[2]) : NaN;
  if (!m || count < 1 || index < 1 || index > count) throw new Error(`shard must be "<i>/<n>" with 1 <= i <= n, got ${JSON.stringify(spec)}`);
  return { index, count };
}

const DETECTED = new Set(["Killed", "Timeout"]);
const VALID = new Set(["Killed", "Timeout", "Survived", "NoCoverage"]);

/**
 * Stryker's mutation score of a JSON report: detected (killed, timeout) / valid (detected, survived, no
 * coverage); compile and runtime errors and ignored mutants do not count. Per file and in total.
 */
export function mutationScore(report) {
  const files = [];
  let detected = 0;
  let valid = 0;
  for (const [name, f] of Object.entries(report.files ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const ms = f.mutants.filter((m) => VALID.has(m.status));
    const d = ms.filter((m) => DETECTED.has(m.status)).length;
    detected += d;
    valid += ms.length;
    files.push({ name, valid: ms.length, detected: d, score: ms.length ? (d / ms.length) * 100 : null });
  }
  return { detected, valid, score: valid ? (detected / valid) * 100 : 0, files };
}

/**
 * Merges Stryker JSON reports of disjoint shards. Throws when a file is in two reports, or when a file of
 * `expected` is missing (a shard that failed or did not run must fail the gate, never shrink it).
 */
export function mergeReports(reports, expected) {
  if (reports.length === 0) throw new Error("no shard reports found");
  const files = {};
  for (const r of reports) {
    for (const [name, f] of Object.entries(r.files ?? {})) {
      const key = name.split("\\").join("/");
      if (files[key]) throw new Error(`${key} is in more than one shard report`);
      files[key] = f;
    }
  }
  const missing = expected.filter((f) => !files[f]);
  if (missing.length > 0) throw new Error(`files missing from the shard reports: ${missing.join(", ")}`);
  const extra = Object.keys(files).filter((f) => !expected.includes(f));
  if (extra.length > 0) throw new Error(`files that stryker.config.mjs does not mutate: ${extra.join(", ")}`);
  return { ...reports[0], files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) };
}
