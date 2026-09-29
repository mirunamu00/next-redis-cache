/**
 * Known-bug reproductions (ROADMAP.md section 6.9, P0d).
 *
 * A reproduction asserts the CORRECT behavior and is registered as an expected failure:
 *   itRepro("7-1", "updateTags with durations keeps fresh entries readable", async () => { ... });
 * With 1.0.6 the assertion fails, so vitest reports the test as passing (`it.fails`). When the bug is
 * fixed the test starts to pass, `it.fails` turns that into a failure, and the fixing commit must
 * replace `itRepro(...)` with a plain `it("[7-x] ...")`. Nothing is ever silently skipped.
 *
 * NRC_REPRO=show registers reproductions as normal tests, which prints the actual failures - that is
 * how the reproduction evidence is produced: `NRC_REPRO=show npx vitest run -t "\[7-"`.
 *
 * The same convention exists in the other layers:
 *   Playwright  test.fail(reproExpected, "[7-x] ...")  (see tests/e2e/fixtures.ts)
 *   tsc         // @ts-expect-error [7-x] ...          (tests/contract/types)
 */
import { it } from "vitest";

export const reproExpected = process.env.NRC_REPRO !== "show";

type TestFn = () => unknown | Promise<unknown>;

export function itRepro(id: string, name: string, fn: TestFn, timeout?: number): void {
  (reproExpected ? it.fails : it)(`[${id}] ${name}`, fn, timeout);
}

/**
 * Collects `unhandledRejection` events while `fn` runs (plus `settleMs` for late rejections).
 * The runner's own listeners are detached meanwhile so a reproduction can count rejections instead
 * of crashing the run, and are restored afterwards.
 */
export async function captureUnhandledRejections(fn: () => Promise<unknown>, settleMs = 200): Promise<unknown[]> {
  const captured: unknown[] = [];
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const listener = (reason: unknown) => captured.push(reason);
  process.on("unhandledRejection", listener);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, settleMs));
  } finally {
    process.off("unhandledRejection", listener);
    for (const l of saved) process.on("unhandledRejection", l as (...args: unknown[]) => void);
  }
  return captured;
}

/** Resolves with "timeout" if `p` does not settle within `ms` (never rejects). */
export function within<T>(p: Promise<T>, ms: number): Promise<{ settled: true; value?: T; error?: unknown } | { settled: false }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  const settled = p.then(
    (value) => ({ settled: true as const, value }),
    (error: unknown) => ({ settled: true as const, error }),
  );
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}
