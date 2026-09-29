// "use cache" handler for the test apps (next.config `cacheHandlers.default` and `.remote`).
//
// NRC_API=v2 (default): createUseCacheHandler(config) - the handler connects lazily (connectRedis) and is
// a no-op during the build by itself. NRC_API=v1 follows the 1.x README (Quick Start, Step 2): no-op
// handler during the build or without REDIS_URL, otherwise a top-level `await client.connect()`.
// Operation counters wrap the handler methods without changing their behavior.
import { assertApi, isBuildPhase, redisUrl, v1KeyPrefix, v2Config } from "./config.mjs";
import { count, observeClient, recordError } from "./test-hooks.mjs";

const noop = {
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  refreshTags: () => Promise.resolve(),
  getExpiration: () => Promise.resolve(0),
  updateTags: () => Promise.resolve(),
};

function instrument(handler) {
  return {
    async get(cacheKey, softTags) {
      count("useCache", "get");
      const entry = await handler.get(cacheKey, softTags);
      count("useCache", entry ? "hit" : "miss");
      return entry;
    },
    set(cacheKey, pendingEntry) {
      count("useCache", "set");
      return handler.set(cacheKey, pendingEntry);
    },
    refreshTags() {
      return handler.refreshTags();
    },
    getExpiration(tags) {
      count("useCache", "getExpiration");
      return handler.getExpiration(tags);
    },
    updateTags(tags, durations) {
      count("useCache", "updateTags");
      return handler.updateTags(tags, durations);
    },
  };
}

let handler = noop;

if (assertApi() === "v1") {
  if (!isBuildPhase() && redisUrl()) {
    const { createUseCacheHandler } = await import("@mirunamu/next-redis-cache/use-cache");
    const { createClient } = await import("@redis/client");
    const client = createClient({ url: redisUrl() });
    client.on("error", (err) => {
      recordError("use-cache-client", err);
    });
    observeClient(client);
    await client.connect();
    handler = createUseCacheHandler({
      client,
      keyPrefix: v1KeyPrefix(),
      useCacheKeyPrefix: `${v1KeyPrefix()}uc:`,
      sharedTagsKey: "_tags",
      sharedTagsTtlKey: "_tagTtls",
      revalidatedTagsKey: "_revalidated",
      timeoutMs: 5000,
    });
  }
} else {
  const { createUseCacheHandler } = await import("@mirunamu/next-redis-cache/use-cache");
  handler = createUseCacheHandler(await v2Config());
}

export default instrument(handler);
