/**
 * Flaky-test policy (ROADMAP.md section 6.6): no retries. A test that proved unstable is quarantined:
 *
 *   itQuarantine("#12 until 2026-10-06", "name", async () => { ... });
 *
 * - The first argument names the tracking issue and the deadline (at most 7 days out);
 *   scripts/check-quarantine.mjs fails the static job once the deadline has passed.
 * - Normal runs skip it (it is excluded from the gate); NRC_QUARANTINE=only runs just the quarantined
 *   tests, 20 times each (nightly), to show whether the fix worked.
 * Playwright uses the tag `@quarantine` in the title plus the same "#issue until date" note, and the
 * nightly job runs `--grep @quarantine --repeat-each=20`.
 */
import { it } from "vitest";

const mode = process.env.NRC_QUARANTINE;

export function itQuarantine(ticket: string, name: string, fn: () => unknown | Promise<unknown>, timeout?: number): void {
  const title = `${name} @quarantine(${ticket})`;
  if (mode === "only") it(title, { repeats: 20, timeout }, fn);
  else it.skip(title, fn);
}
