// Tests for the quality gates themselves (Q13, blocking from 2.0.0): the coverage gate must fail below
// any threshold, and the mutation run must break below 70%.
import { describe, expect, it } from "vitest";
import { coverageFailures, PER_FILE_LINES, THRESHOLDS } from "../../scripts/lib/coverage-rules.mjs";
import stryker from "../../stryker.config.mjs";

const metric = (pct: number) => ({ total: 100, covered: pct, skipped: 0, pct });
const entry = (lines: number, branches = 90, functions = 95) => ({
  lines: metric(lines),
  statements: metric(lines),
  branches: metric(branches),
  functions: metric(functions),
});

describe("coverageFailures", () => {
  it("passes at exactly the thresholds", () => {
    const summary = { total: entry(THRESHOLDS.lines, THRESHOLDS.branches, THRESHOLDS.functions), "/r/src/a.ts": entry(PER_FILE_LINES) };
    expect(coverageFailures(summary)).toEqual([]);
  });

  it("fails on each global metric below its threshold", () => {
    expect(coverageFailures({ total: entry(89.99) })).toEqual(["lines 89.99% < 90%"]);
    expect(coverageFailures({ total: entry(95, 84.9) })).toEqual(["branches 84.9% < 85%"]);
    expect(coverageFailures({ total: entry(95, 90, 89) })).toEqual(["functions 89% < 90%"]);
  });

  it("fails on a single file below the per-file line threshold, named through the mapper", () => {
    const summary = { total: entry(97), "/r/src/a.ts": entry(100), "/r/src/b.ts": entry(79.9) };
    expect(coverageFailures(summary, (f) => f.replace("/r/", ""))).toEqual(["src/b.ts: lines 79.9% < 80%"]);
  });

  it("skips files without any line to cover (re-export-only entries are reported as 0 of 0 = 0%)", () => {
    const empty = { lines: { total: 0, covered: 0, skipped: 0, pct: 0 }, statements: metric(0), branches: metric(0), functions: metric(0) };
    expect(coverageFailures({ total: entry(97), "/r/src/index.ts": empty })).toEqual([]);
  });

  it("fails on a report without totals or with missing metrics", () => {
    expect(coverageFailures({})).toEqual(["the report has no total"]);
    expect(coverageFailures({ total: { lines: metric(99) } } as never)).toHaveLength(2);
  });
});

describe("mutation gate", () => {
  it("Stryker breaks the run below 70%", () => {
    expect(stryker.thresholds?.break).toBe(70);
  });
});
