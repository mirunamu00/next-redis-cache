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
