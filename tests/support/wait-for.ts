/**
 * Deadline-bounded polling. Tests use this instead of fixed sleeps (ROADMAP.md section 6.6):
 * a condition that becomes true early returns early, and a condition that never becomes true
 * fails with a clear message instead of hanging.
 */
export interface WaitForOptions {
  /** Maximum wait in ms (default 5000). */
  timeout?: number;
  /** Poll interval in ms (default 25). */
  interval?: number;
  /** Description used in the timeout error. */
  message?: string;
}

export async function waitFor<T>(
  check: () => T | Promise<T>,
  { timeout = 5000, interval = 25, message = "condition" }: WaitForOptions = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const cause = lastError ? `; last error: ${String(lastError)}` : "";
      throw new Error(`waitFor: ${message} not met within ${timeout}ms${cause}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Measures how long an async operation takes, in ms. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
}

/**
 * Resolves once Date.now() has moved at least `ms` past the time of the call. Tests that order an entry
 * and an invalidation by time use this instead of a fixed sleep: the comparisons are strict (Next's
 * `expired > timestamp`), and a timer alone does not guarantee that the wall clock moved.
 */
export async function clockAdvance(ms = 2): Promise<void> {
  const target = Date.now() + ms;
  while (Date.now() < target) await new Promise((r) => setTimeout(r, 1));
}
