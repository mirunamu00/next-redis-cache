# Migrating from 1.x to 2.x

2.0 replaces the static `LegacyCacheHandler` and the key layout of 1.x. Entries are stored in a new format under new keys, so a 2.x deployment starts with an empty cache for its build - with the build-output fallback that costs no failed requests, only renders that re-fill Redis. Plan the switch like any deployment of a new build; 1.x and 2.x instances can run side by side during a rolling update (see [Rolling update from 1.x](#rolling-update-from-1x)).

## Requirements

| | 1.x | 2.x |
| --- | --- | --- |
| `next` | `>=15.0.0` (15 untested) | `^16.1.0` |
| `@redis/client` | `^5.0.0 \|\| ^6.0.0` | `^5.0.0 \|\| ^6.0.0` |
| Node.js | `>=18.18.0` | `>=20.9.0` |
| Redis | - | 6.2+ (7.4+ for `tagStateTtlSeconds`) |

## 1. One configuration instead of `onCreation` hooks

1.x:

```js
// cache-handler.mjs (1.x)
import { LegacyCacheHandler } from "@mirunamu/next-redis-cache";

LegacyCacheHandler.onCreation(async () => {
  if (process.env.NEXT_PHASE === "phase-production-build" || !process.env.REDIS_URL) return null;
  const { createClient } = await import("@redis/client");
  const client = createClient({ url: process.env.REDIS_URL });
  client.on("error", () => {});
  await client.connect();
  return { client, keyPrefix: `myapp:${buildId}:`, sharedTagsKey: "_tags", sharedTagsTtlKey: "_tagTtls", revalidatedTagsKey: "_revalidated" };
});
export default LegacyCacheHandler;
```

2.x - create one config module and use it in both handler files:

```js
// cache/config.mjs
import { connectRedis } from "@mirunamu/next-redis-cache/redis";

export const cacheConfig = {
  client: () => connectRedis(process.env.REDIS_URL), // null without REDIS_URL
  namespace: "myapp",
  buildId: process.env.BUILD_ID,
};
```

```js
// cache-handler.mjs
import { createCacheHandler } from "@mirunamu/next-redis-cache";
import { cacheConfig } from "./cache/config.mjs";
export default createCacheHandler(cacheConfig);
```

```js
// use-cache-handler.mjs
import { createUseCacheHandler } from "@mirunamu/next-redis-cache/use-cache";
import { cacheConfig } from "./cache/config.mjs";
export default createUseCacheHandler(cacheConfig);
```

What you can delete:

- the build-phase check (`NEXT_PHASE`) and the no-op `"use cache"` handler: the handlers are no-ops during `next build` by themselves (`disabled`);
- `await client.connect()` and any bounded-wait workaround: `connectRedis` waits at most 1 s and reconnects in the background; the handlers never send while the client is not ready;
- the `"error"` listener: `connectRedis` attaches one and logs transitions only;
- a wrapper that serves pages from the build output when Redis misses: built in (`fallback`);
- your own timeouts and circuit breaker: built in (`timeouts`, `circuitBreaker`).

A client you create yourself still works: pass it as `client` (connected or not) and keep its `"error"` listener.

## 2. Options

| 1.x | 2.x |
| --- | --- |
| `keyPrefix: "myapp:<build>:"` | `namespace: "myapp"` + `buildId` (keys become `myapp:<build>:e:<key>`) |
| `useCacheKeyPrefix` | gone: `"use cache"` entries live under `myapp:<build>:u:<key>` |
| `sharedTagsKey`, `sharedTagsTtlKey`, `revalidatedTagsKey` | gone: one tag state `myapp:_tagstate`, shared by both handlers and every build |
| `timeoutMs` (5000) | `timeouts: { readMs: 1000, writeMs: 2000 }` + `circuitBreaker: { openMs: 10000 }` |
| `defaultStaleAge` (1 year), `estimateExpireAge` | `ttl: { staticSeconds: 30 days, maxSeconds: 365 days, estimateExpire }` - TTLs now count from the write |
| - | `fallback`, `onTagExpired`, `compression`, `tagStateTtlSeconds`, `logger`, `onEvent`, `disabled` |
| `createUseCacheHandler` options | the same config (+ `swr`, `tagStateCacheMs`) |

`LegacyCacheHandler` (named and default export) and the `OnCreationHook`, `LegacyHandlerConfig`, `RedisHandlerOptions`, `ResolvedRedisOptions` and `UseCacheHandlerOptions` types are removed.

## 3. Instrumentation

1.x:

```ts
// instrumentation.ts (1.x)
await cleanupOldBuildKeys({ redisUrl: process.env.REDIS_URL, patterns: [{ scan: "myapp:*", keepPrefix: `myapp:${buildId}:` }] });
await registerInitialCache(CacheHandler, { setOnlyIfNotExists: true });
```

2.x:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startCacheMaintenance } = await import("@mirunamu/next-redis-cache/instrumentation");
    const { cacheConfig } = await import("./cache/config.mjs");
    startCacheMaintenance({ config: cacheConfig }); // not awaited
  }
}
```

- `registerInitialCache` is removed. Prewarming is optional now (pages are served from the build output and written back on first use); to prewarm anyway use `startCacheMaintenance({ config, prewarm: true })` or `prewarmFromBuildOutput(config)`.
- `cleanupOldBuildKeys` still exists but is deprecated (removed in 3.0): it deletes whatever its patterns match, including keys of instances that are still serving during a rolling update. `startCacheMaintenance` keeps the current and the previous build, removes other builds only when nobody has read them for 30 minutes, and waits for Redis instead of skipping the run.

## 4. Behavior changes

- **Invalidation no longer deletes keys.** `revalidateTag`/`updateTag`/`revalidatePath` record times in the tag state; entries are checked when read. An invalidated `dynamicParams = false` page is never a 404 (1.x deleted it and Next answered 404).
- **`revalidateTag(tag, profile)` is stale-while-revalidate** in both handlers (1.1 treated it like `updateTag`). `updateTag` and `revalidatePath` are misses on the next read of pages, route handlers and `"use cache"` entries, except where a miss would be a 404 (`onTagExpired`).
- **TTLs are shorter and count from the write**: static pages 30 days (1.x: 1.5 years from the build time), numeric `revalidate` x 1.5, everything capped at 365 days. Re-seeding an old build no longer expires immediately.
- **Entries are binary and brotli-compressed**: `redis-cli GET` shows bytes, not JSON. Use `compression: "none"` if you need smaller CPU use over memory; reading works with every setting.
- **Errors are logged by default** (transition-based); use `logger` to route or silence them.

## Rolling update from 1.x

1.x and 2.x use different keys and do not read each other's entries, so they can serve side by side: the 2.x instances start with an empty cache for their build and fill it (build-output fallback + re-seeding, or prewarm). Invalidations made by 1.x instances are not seen by 2.x instances and vice versa until the rollout is over.

After the switch:

- `startCacheMaintenance` in the same `namespace` removes the old 1.x keys (`myapp:<build>:<key>` and `myapp:<build>:_tags`, ...) once they have been idle for 30 minutes.
- 1.x `"use cache"` entries under the default `uc:` prefix live outside the namespace; remove them once with `cleanupOldBuildKeys({ redisUrl, patterns: [{ scan: "uc:myapp:*" }] })`, or let them expire.
- Rolling back to a 1.x image: a 1.x cleanup that keeps only its own prefix deletes `myapp:_tagstate` and `myapp:_builds` like any other key. That only loses 2.x invalidation times (2.x entries are rendered again after the next invalidation) and the build registry; 2.x recreates both.
