export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const CacheHandler = (await import("../cache-handler.mjs")).default;
    const { registerInitialCache } = await import(
      "@mirunamu/next-redis-cache/instrumentation"
    );

    const buildId = process.env.BUILD_ID || "test-default";

    // Only run Redis cleanup when Redis is available
    if (process.env.REDIS_URL) {
      const { cleanupOldBuildKeys } = await import(
        "@mirunamu/next-redis-cache/instrumentation"
      );
      await cleanupOldBuildKeys({
        redisUrl: process.env.REDIS_URL,
        patterns: [{ scan: "test:*", keepPrefix: `test:${buildId}:` }],
      });
    }

    await registerInitialCache(CacheHandler, { setOnlyIfNotExists: true });
  }
}
