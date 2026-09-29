// Contract (types): the use-cache handler must satisfy Next's CacheHandler interface for every supported
// Next version (ROADMAP.md section 6.5 contract-types). Compiled by scripts/contract-types.mjs against the
// published package (tarball) and each variant's `next`; never executed.
import type { CacheHandler } from "next/dist/server/lib/cache-handlers/types.js";
import { createClient, type RedisClientType } from "@redis/client";
import { createUseCacheHandler } from "@mirunamu/next-redis-cache/use-cache";
import { connectRedis } from "@mirunamu/next-redis-cache/redis";

declare const client: RedisClientType;

export const handler = createUseCacheHandler({ client, namespace: "app" }) satisfies CacheHandler;
export const lazy = createUseCacheHandler({ client: () => connectRedis(process.env.REDIS_URL), namespace: "app", swr: false, tagStateCacheMs: 500 }) satisfies CacheHandler;
// A RESP3 client (the @redis/client 6 default) is accepted as well
export const resp3 = createUseCacheHandler({ client: createClient({ RESP: 3 }), namespace: "app" }) satisfies CacheHandler;

// Every method Next calls must exist with a compatible signature
export const methods: Array<keyof CacheHandler> = ["get", "set", "refreshTags", "getExpiration", "updateTags"];
