// Contract (types): the class createCacheHandler returns must be usable where Next expects its `cacheHandler`
// class: constructed with CacheHandlerContext, exposing get/set/revalidateTag/resetRequestCache with
// compatible signatures. (1.x declared its own context type with an index signature and failed here, 7-8.)
import type { CacheHandler, CacheHandlerContext } from "next/dist/server/lib/incremental-cache/index.js";
import type { RedisClientType } from "@redis/client";
import { createCacheHandler, type RedisCacheConfig } from "@mirunamu/next-redis-cache";
import { connectRedis } from "@mirunamu/next-redis-cache/redis";

type NextCacheHandlerClass = new (ctx: CacheHandlerContext) => Pick<CacheHandler, "get" | "set" | "revalidateTag" | "resetRequestCache">;

declare const client: RedisClientType;

export const withInstance: NextCacheHandlerClass = createCacheHandler({ client, namespace: "app" });
export const withConnect: NextCacheHandlerClass = createCacheHandler({ client: () => connectRedis(process.env.REDIS_URL), namespace: "app" });

// Every documented option type-checks
export const full: RedisCacheConfig = {
  client: null,
  namespace: "app",
  buildId: "b1",
  timeouts: { readMs: 500, writeMs: 1000 },
  circuitBreaker: { openMs: 5000 },
  fallback: { buildOutput: true, reseed: false },
  ttl: { staticSeconds: 3600, maxSeconds: 86400, estimateExpire: (s) => s * 2 },
  onTagExpired: "miss",
  compression: "gzip",
  logger: { warn: console.warn },
  onEvent: (e) => {
    if (e.type === "miss") void e.reason;
  },
  disabled: () => false,
};
