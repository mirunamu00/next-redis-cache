import { LegacyCacheHandler } from "@mirunamu/cache-handler";
import { storeCacheEntry } from "./logger.mjs";

const buildId = process.env.BUILD_ID || "test-default";

// Patch prototype to capture cache data for the viewer
const origSet = LegacyCacheHandler.prototype.set;
LegacyCacheHandler.prototype.set = async function (...args) {
  const key = args[0];
  const data = args[1];
  await origSet.apply(this, args);
  storeCacheEntry("legacy", key, data, {
    ttl: data?.revalidate ?? -1,
    tags: data?.tags ?? [],
  });
};

LegacyCacheHandler.onCreation(async () => {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return null;
  }

  // No Redis URL → skip Redis, cache handler works with defaults only
  if (!process.env.REDIS_URL) {
    return null;
  }

  const { createClient } = await import("@redis/client");
  const client = createClient({
    url: process.env.REDIS_URL,
  });
  client.on("error", (err) => console.error("[test:redis]", err.message));
  await client.connect();

  return {
    client,
    keyPrefix: `test:${buildId}:`,
    sharedTagsKey: `test:${buildId}:_tags`,
    sharedTagsTtlKey: `test:${buildId}:_tagTtls`,
    revalidatedTagsKey: `__revalidated_tags__`,
  };
});

export default LegacyCacheHandler;
