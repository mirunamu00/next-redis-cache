// Test observability shared by the cache handler adapters, instrumentation and the test API routes
// (ROADMAP.md section 6.3). Everything lives on one globalThis slot so that the cache handler modules
// (loaded by the Next server outside the bundle) and the bundled route handlers see the same counters.
//
// Only active with TEST_HOOKS=1; otherwise every function here is a cheap no-op.

const SLOT = Symbol.for("nrc.test-hooks");

export const hooksEnabled = () => process.env.TEST_HOOKS === "1";

/** Shared state: per-handler operation counters, unhandled rejection count, recent errors. */
export function testState() {
  const g = globalThis;
  if (!g[SLOT]) {
    g[SLOT] = {
      startedAt: Date.now(),
      stats: {
        legacy: { get: 0, hit: 0, miss: 0, set: 0, revalidateTag: 0, error: 0 },
        useCache: { get: 0, hit: 0, miss: 0, set: 0, updateTags: 0, getExpiration: 0, error: 0 },
      },
      unhandledRejections: 0,
      uncaughtExceptions: 0,
      lastErrors: [],
      redis: { ready: 0, error: 0, end: 0 },
    };
  }
  return g[SLOT];
}

/** Increments `stats[handler][op]`. */
export function count(handler, op) {
  if (!hooksEnabled()) return;
  const s = testState().stats[handler];
  s[op] = (s[op] ?? 0) + 1;
}

/** Keeps the last 20 errors for /api/nrc-test/stats. */
export function recordError(where, err) {
  if (!hooksEnabled()) return;
  const list = testState().lastErrors;
  list.push({ where, message: String(err?.message ?? err), at: Date.now() });
  if (list.length > 20) list.shift();
}

/** Registers process-level listeners once (called from instrumentation). */
export function installProcessHooks() {
  if (!hooksEnabled()) return;
  const state = testState();
  if (state.processHooksInstalled) return;
  state.processHooksInstalled = true;
  process.on("unhandledRejection", (reason) => {
    state.unhandledRejections += 1;
    recordError("unhandledRejection", reason);
  });
}

/** Attaches connection lifecycle counters to a redis client. */
export function observeClient(client) {
  if (!hooksEnabled()) return;
  const r = testState().redis;
  client.on("ready", () => (r.ready += 1));
  client.on("error", () => (r.error += 1));
  client.on("end", () => (r.end += 1));
}

/** JSON body for the stats route. */
export function snapshot() {
  const s = testState();
  return {
    instance: process.env.INSTANCE_ID ?? null,
    build: process.env.BUILD_ID ?? null,
    api: process.env.NRC_API ?? "v1",
    pid: process.pid,
    uptimeMs: Date.now() - s.startedAt,
    stats: s.stats,
    redis: s.redis,
    unhandledRejections: s.unhandledRejections,
    lastErrors: s.lastErrors,
  };
}

/** Marker attributes rendered into pages (see markers.jsx). */
export function markerAttributes() {
  return {
    "data-build": process.env.BUILD_ID ?? "unknown",
    "data-render-id": globalThis.crypto.randomUUID(),
    "data-rendered-at": String(Date.now()),
    "data-instance": process.env.INSTANCE_ID ?? (process.env.NEXT_PHASE === "phase-production-build" ? "build" : "unknown"),
  };
}
