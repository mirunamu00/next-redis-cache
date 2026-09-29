// Node-runtime part of the test apps' instrumentation (imported from instrumentation.js).
//
//   NRC_PREWARM=1  v1: registerInitialCache(CacheHandler, { setOnlyIfNotExists: true }) as in the README
//   NRC_CLEANUP=1  v1: cleanupOldBuildKeys({ patterns: [{ scan: `${ns}:*`, keepPrefix }] }) as in the README
// Both are awaited, like the README's Step 4 example. The reproduction tests rely on that wiring.
import { api, isBuildPhase, namespace, redisUrl, v1KeyPrefix } from "./config.mjs";
import { installProcessHooks } from "./test-hooks.mjs";

export async function registerNode() {
  installProcessHooks();
  if (isBuildPhase() || api() !== "v1") return;

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
}
