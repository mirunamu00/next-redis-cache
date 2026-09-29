// Coverage gate rules (ROADMAP.md section 6.6, decision Q13: blocking from 2.0.0). Shared by
// scripts/coverage-summary.mjs and its unit test.
//
// The thresholds apply to the merged coverage of every layer (unit, property, contract, integration,
// fault) that the ci `coverage` job produces; a single layer alone is never gated.

/** Global thresholds (percent) of the merged report. */
export const THRESHOLDS = { lines: 90, branches: 85, functions: 90 };

/** Every file must reach this line coverage on its own. */
export const PER_FILE_LINES = 80;

/**
 * Checks an istanbul json-summary report (`coverage/coverage-summary.json`).
 * @param {Record<string, Record<string, { pct: number }>>} summary
 * @param {(file: string) => string} [name] maps a report path to the name used in messages
 * @returns {string[]} one message per violated threshold (empty = pass)
 */
export function coverageFailures(summary, name = (f) => f) {
  const failures = [];
  const total = summary.total;
  if (!total) return ["the report has no total"];
  for (const [metric, min] of Object.entries(THRESHOLDS)) {
    const pct = total[metric]?.pct;
    if (typeof pct !== "number" || !(pct >= min)) failures.push(`${metric} ${pct}% < ${min}%`);
  }
  for (const [file, m] of Object.entries(summary)) {
    if (file === "total") continue;
    // re-export-only entry files (index.ts, use-cache.ts, ...) have nothing to cover: v8 reports 0 of 0 as 0%
    if (m.lines?.total === 0) continue;
    const pct = m.lines?.pct;
    if (typeof pct !== "number" || !(pct >= PER_FILE_LINES)) failures.push(`${name(file)}: lines ${pct}% < ${PER_FILE_LINES}%`);
  }
  return failures;
}
