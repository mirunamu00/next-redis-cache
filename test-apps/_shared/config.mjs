// Environment contract shared by every test app (ROADMAP.md section 6.3).
//
//   NRC_API     v2 (default) = 2.x API (createCacheHandler, createUseCacheHandler, connectRedis)
//               v1           = 1.x API (LegacyCacheHandler.onCreation) - only with a 1.x package
//                              (prepare-app --pkg npm:1.0.6 --api v1), for baselines
//   REDIS_URL   Redis to use; empty = no Redis (handlers fall back to their "no Redis" behavior)
//   TEST_NS     key namespace, isolates test runs sharing one Redis (default "nrc")
//   BUILD_ID    build identifier, also used by next.config generateBuildId
//   INSTANCE_ID set by scripts/fleet.mjs, rendered into test markers
//   ORIGIN_URL  origin server (scripts/origin-server.mjs) used by data-fetching pages
//   TEST_HOOKS  1 = expose test markers and /api/nrc-test/* routes
// v2 tuning (all optional): NRC_READ_MS, NRC_WRITE_MS, NRC_OPEN_MS (0 = no circuit breaker),
// NRC_FALLBACK=0, NRC_RESEED=0, NRC_COMPRESSION=none|gzip|brotli, NRC_TAG_CACHE_MS, NRC_CONNECT_WAIT_MS
import { countEvent, observeClient } from "./test-hooks.mjs";

export const api = () => process.env.NRC_API ?? "v2";
export const namespace = () => process.env.TEST_NS || "nrc";
export const buildId = () => process.env.BUILD_ID || "default";
export const redisUrl = () => process.env.REDIS_URL || "";
export const originUrl = () => process.env.ORIGIN_URL || "http://127.0.0.1:4010";
export const isBuildPhase = () => process.env.NEXT_PHASE === "phase-production-build";

/** v1 key prefix: `${ns}:${buildId}:`, the layout the 1.x README recommends. */
export const v1KeyPrefix = () => `${namespace()}:${buildId()}:`;

export function assertApi() {
  const a = api();
  if (a !== "v1" && a !== "v2") throw new Error(`NRC_API must be v1 or v2, got "${a}"`);
  return a;
}

const num = (name) => (process.env[name] ? Number(process.env[name]) : undefined);

/**
 * The 2.x configuration shared by both handlers and the instrumentation - the wiring the 2.x README
 * recommends (one config module, connectRedis as a lazy client).
 */
export async function v2Config() {
  const { connectRedis } = await import("@mirunamu/next-redis-cache/redis");
  const fallbackOff = process.env.NRC_FALLBACK === "0";
  return {
    client: async () => {
      const client = await connectRedis(redisUrl() || undefined, { label: "test-app", waitMs: num("NRC_CONNECT_WAIT_MS") });
      if (client) observeClient(client);
      return client;
    },
    namespace: namespace(),
    buildId: buildId(),
    timeouts: { readMs: num("NRC_READ_MS"), writeMs: num("NRC_WRITE_MS") },
    circuitBreaker: process.env.NRC_OPEN_MS === "0" ? false : { openMs: num("NRC_OPEN_MS") },
    fallback: fallbackOff ? false : { reseed: process.env.NRC_RESEED !== "0" },
    compression: process.env.NRC_COMPRESSION || undefined,
    tagStateCacheMs: num("NRC_TAG_CACHE_MS"),
    onEvent: countEvent,
  };
}
