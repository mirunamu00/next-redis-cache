// Environment contract shared by every test app (ROADMAP.md section 6.3).
//
//   NRC_API     v1 (default) = 1.x API (LegacyCacheHandler.onCreation, createUseCacheHandler)
//               v2           = 2.x factory API (available from P2)
//   REDIS_URL   Redis to use; empty = no Redis (handlers fall back to their "no Redis" behavior)
//   TEST_NS     key namespace, isolates test runs sharing one Redis (default "nrc")
//   BUILD_ID    build identifier, also used by next.config generateBuildId
//   INSTANCE_ID set by scripts/fleet.mjs, rendered into test markers
//   ORIGIN_URL  origin server (scripts/origin-server.mjs) used by data-fetching pages
//   TEST_HOOKS  1 = expose test markers and /api/nrc-test/* routes

export const api = () => process.env.NRC_API ?? "v1";
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
