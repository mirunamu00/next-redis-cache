import { storeCacheEntry } from "./logger.mjs";

const buildId = process.env.BUILD_ID || "test-default";
let handler;

const noopHandler = {
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  refreshTags: () => Promise.resolve(),
  getExpiration: () => Promise.resolve(0),
  updateTags: () => Promise.resolve(),
};

if (process.env.NEXT_PHASE === "phase-production-build" || !process.env.REDIS_URL) {
  // Build time or no Redis → noop, but still capture set data for viewer
  handler = {
    ...noopHandler,
    async set(cacheKey, pendingEntry) {
      storeCacheEntry("use-cache", cacheKey, pendingEntry, {
        tags: pendingEntry?.tags ?? [],
      });
    },
  };
} else {
  const { createUseCacheHandler } = await import("@mirunamu/cache-handler/use-cache");
  const { createClient } = await import("@redis/client");

  const client = createClient({
    url: process.env.REDIS_URL,
  });
  client.on("error", (err) => console.error("[test:redis]", err.message));
  await client.connect();

  const inner = createUseCacheHandler({
    client,
    keyPrefix: `test:${buildId}:`,
    useCacheKeyPrefix: `test:${buildId}:_useCache:`,
    revalidatedTagsKey: `__revalidated_tags__`,
    timeoutMs: 5000,
  });

  handler = {
    async get(cacheKey, softTags) {
      return inner.get(cacheKey, softTags);
    },
    async set(cacheKey, pendingEntry) {
      await inner.set(cacheKey, pendingEntry);
      storeCacheEntry("use-cache", cacheKey, pendingEntry, {
        tags: pendingEntry?.tags ?? [],
      });
    },
    async refreshTags() {
      await inner.refreshTags();
    },
    async getExpiration(tags) {
      return inner.getExpiration(tags);
    },
    async updateTags(tags, durations) {
      await inner.updateTags(tags, durations);
    },
  };
}

export default handler;
