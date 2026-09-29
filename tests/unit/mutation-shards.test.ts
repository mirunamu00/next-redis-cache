// Tests for the sharded weekly mutation run (ROADMAP.md D59): every mutated file lands in exactly one shard,
// the merge refuses incomplete or overlapping shard reports, and the score is Stryker's.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import stryker, { MUTATION_BREAK } from "../../stryker.config.mjs";
import {
  globToRegExp,
  mergeReports,
  mutateTargets,
  mutationScore,
  parseShard,
  planShards,
  selectFiles,
  weightOf,
} from "../../scripts/lib/mutation-shards.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MUTATE = stryker.mutate as string[];

describe("file selection", () => {
  it("matches Stryker-style globs", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/x/y/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/a.tsx")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/x/a.ts")).toBe(false);
    expect(globToRegExp("src/a?.ts").test("src/ab.ts")).toBe(true);
    expect(globToRegExp("src/a.ts").test("srcXa.ts")).toBe(false);
  });

  it("applies exclusions", () => {
    expect(selectFiles(["src/**/*.ts", "!src/types.ts"], ["src/types.ts", "src/b.ts", "src/a.ts", "tests/a.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("the repository's mutate patterns select the handler sources but not the entry files", () => {
    const files = mutateTargets(ROOT, MUTATE).map((t) => t.file);
    expect(files).toContain("src/legacy-handler.ts");
    expect(files).toContain("src/maintenance.ts");
    for (const excluded of ["src/types.ts", "src/index.ts", "src/use-cache.ts", "src/instrumentation.ts", "src/redis-entry.ts"]) expect(files).not.toContain(excluded);
  });

  it("weighs code, not comments or blank space", () => {
    expect(weightOf("/* long\n comment */\nconst a = 1; // note\n\n")).toBe(weightOf("const a = 1;"));
    expect(weightOf('const url = "redis://host"; // x')).toBe(weightOf('const url = "redis://host";'));
  });
});

describe("planShards", () => {
  const weighted = [
    { file: "src/a.ts", weight: 10 },
    { file: "src/b.ts", weight: 9 },
    { file: "src/c.ts", weight: 4 },
    { file: "src/d.ts", weight: 3 },
    { file: "src/e.ts", weight: 3 },
  ];

  it("is deterministic and puts each file in exactly one shard, heaviest first to the lightest shard", () => {
    expect(planShards(weighted, 2)).toEqual([
      ["src/a.ts", "src/d.ts", "src/e.ts"],
      ["src/b.ts", "src/c.ts"],
    ]);
    expect(planShards([...weighted].reverse(), 2)).toEqual(planShards(weighted, 2));
    expect(planShards(weighted, 1)).toEqual([["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]]);
  });

  it.each([1, 2, 3, 4, 5, 6])("the repository's files in %i shards: disjoint, complete, none empty", (count) => {
    const targets = mutateTargets(ROOT, MUTATE);
    const shards = planShards(targets, count);
    const all = shards.flat();
    expect(all.sort()).toEqual(targets.map((t) => t.file).sort());
    expect(new Set(all).size).toBe(all.length);
    for (const s of shards) expect(s.length).toBeGreaterThan(0);
  });

  it("rejects a bad shard count", () => {
    expect(() => planShards(weighted, 0)).toThrow(/positive integer/);
  });
});

describe("parseShard", () => {
  it("parses i/n and rejects anything else", () => {
    expect(parseShard("2/5")).toEqual({ index: 2, count: 5 });
    for (const bad of ["0/5", "6/5", "2", "a/b", "", undefined]) expect(() => parseShard(bad)).toThrow(/shard must be/);
  });
});

const report = (files: Record<string, string[]>) => ({
  schemaVersion: "2",
  thresholds: { high: 80, low: 70 },
  files: Object.fromEntries(Object.entries(files).map(([name, statuses]) => [name, { language: "typescript", source: "", mutants: statuses.map((status, i) => ({ id: `${name}#${i}`, status })) }])),
});

describe("mergeReports", () => {
  it("merges disjoint shard reports into one, files sorted", () => {
    const merged = mergeReports([report({ "src/b.ts": ["Killed"] }), report({ "src/a.ts": ["Survived"] })], ["src/a.ts", "src/b.ts"]);
    expect(Object.keys(merged.files)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(merged.schemaVersion).toBe("2");
  });

  it("normalizes Windows separators", () => {
    expect(Object.keys(mergeReports([report({ "src\\a.ts": ["Killed"] })], ["src/a.ts"]).files)).toEqual(["src/a.ts"]);
  });

  it("fails on a missing shard, an overlap, an unexpected file or no report at all", () => {
    expect(() => mergeReports([report({ "src/a.ts": ["Killed"] })], ["src/a.ts", "src/b.ts"])).toThrow("files missing from the shard reports: src/b.ts");
    expect(() => mergeReports([report({ "src/a.ts": [] }), report({ "src/a.ts": [] })], ["src/a.ts"])).toThrow("src/a.ts is in more than one shard report");
    expect(() => mergeReports([report({ "src/a.ts": [], "src/z.ts": [] })], ["src/a.ts"])).toThrow("files that stryker.config.mjs does not mutate: src/z.ts");
    expect(() => mergeReports([], ["src/a.ts"])).toThrow("no shard reports found");
  });
});

describe("mutationScore", () => {
  it("counts killed and timeout as detected, survived and no coverage as undetected, ignores errors", () => {
    const r = report({ "src/a.ts": ["Killed", "Timeout", "Survived", "NoCoverage", "CompileError", "RuntimeError", "Ignored"], "src/b.ts": ["Killed"] });
    const s = mutationScore(r);
    expect(s).toMatchObject({ detected: 3, valid: 5, score: 60 });
    expect(s.files).toEqual([
      { name: "src/a.ts", valid: 4, detected: 2, score: 50 },
      { name: "src/b.ts", valid: 1, detected: 1, score: 100 },
    ]);
    expect(mutationScore(report({})).score).toBe(0);
  });

  it("the break threshold is 70 %, and unsharded runs break on it", () => {
    expect(MUTATION_BREAK).toBe(70);
    // these tests also run inside a sharded Stryker run, which sets NRC_MUTATION_SHARD
    expect(stryker.thresholds?.break).toBe(process.env.NRC_MUTATION_SHARD ? null : MUTATION_BREAK);
  });
});
