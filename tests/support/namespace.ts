/**
 * Test isolation on a shared Redis (ROADMAP.md section 6.6).
 *
 * - Every test gets a unique key namespace `t_<pid>_<seq>`; tests that only touch their own
 *   namespace can share one database safely.
 * - Tests that scan or flush globally use a logical database owned by their vitest worker
 *   (`VITEST_POOL_ID % 16`) and only ever FLUSHDB that database.
 */
let seq = 0;

/** Unique namespace for this process, e.g. `t_12345_7` or `t_12345_7_label`. */
export function uniqueNamespace(label?: string): string {
  seq += 1;
  const base = `t_${process.pid}_${seq}`;
  return label ? `${base}_${label.replace(/[^A-Za-z0-9_-]/g, "_")}` : base;
}

/** 1-based vitest pool id of the current worker (1 outside vitest). */
export function poolId(): number {
  const id = Number(process.env.VITEST_POOL_ID ?? "1");
  return Number.isInteger(id) && id > 0 ? id : 1;
}

/** Logical Redis database owned by this worker, 0-15. */
export function workerDatabase(): number {
  return poolId() % 16;
}
