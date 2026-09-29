// Contract (types): the use-cache handler must satisfy Next's CacheHandler interface for every
// supported Next version (ROADMAP.md section 6.5 contract-types). Compiled by scripts/contract-types.mjs
// against the published package (tarball) and each variant's `next`; never executed.
import type { CacheHandler } from "next/dist/server/lib/cache-handlers/types.js";
import type { RedisClientType } from "@redis/client";
import { createUseCacheHandler } from "@mirunamu/next-redis-cache/use-cache";

declare const client: RedisClientType;

export const handler = createUseCacheHandler({ client }) satisfies CacheHandler;

// Every method Next calls must exist with a compatible signature
export const methods: Array<keyof CacheHandler> = ["get", "set", "refreshTags", "getExpiration", "updateTags"];
