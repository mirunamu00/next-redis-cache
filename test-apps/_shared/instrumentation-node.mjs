// Node-runtime part of the test apps' instrumentation (imported from instrumentation.js).
//
// v2 (default):
//   NRC_PREWARM=1   await prewarmFromBuildOutput(config) - awaited so tests start on a warm cache
//   NRC_CLEANUP=1   startCacheMaintenance({ config, cleanup }) in the background (not awaited, like the README)
//                   NRC_CLEANUP_MIN_IDLE (seconds) overrides minIdleSeconds
// v1 (1.x package): the 1.x README Step 4 - cleanupOldBuildKeys and registerInitialCache, both awaited.
import { api, isBuildPhase, namespace, redisUrl, v1KeyPrefix, v2Config } from "./config.mjs";
import { installProcessHooks, recordMaintenance } from "./test-hooks.mjs";

export async function registerNode() {
  installProcessHooks();
  if (isBuildPhase()) return;

  if (api() === "v1") {
    if (process.env.NRC_CLEANUP === "1" && redisUrl()) {
      const { cleanupOldBuildKeys } = await import("@mirunamu/next-redis-cache/instrumentation");
      await cleanupOldBuildKeys({
        redisUrl: redisUrl(),
        patterns: [{ scan: `${namespace()}:*`, keepPrefix: v1KeyPrefix() }],
      });
    }
    if (process.env.NRC_PREWARM === "1") {
      const { registerInitialCache } = await import("@mirunamu/next-redis-cache/instrumentation");
      const CacheHandler = (await import("./cache-handler.mjs")).default;
      await registerInitialCache(CacheHandler, { setOnlyIfNotExists: true });
    }
    return;
  }

  const instrumentation = await import("@mirunamu/next-redis-cache/instrumentation");
  const config = await v2Config();
  if (process.env.NRC_PREWARM === "1") {
    recordMaintenance("prewarm", await instrumentation.prewarmFromBuildOutput(config));
  }
  if (process.env.NRC_CLEANUP === "1" && typeof instrumentation.startCacheMaintenance === "function") {
    const minIdleSeconds = process.env.NRC_CLEANUP_MIN_IDLE ? Number(process.env.NRC_CLEANUP_MIN_IDLE) : undefined;
    const { done } = instrumentation.startCacheMaintenance({ config, cleanup: { minIdleSeconds }, prewarm: false });
    void done.then((result) => recordMaintenance("maintenance", result));
  }
}
