# @mirunamu/next-redis-cache

[![npm version](https://img.shields.io/npm/v/@mirunamu/next-redis-cache.svg)](https://www.npmjs.com/package/@mirunamu/next-redis-cache)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Next.js](https://img.shields.io/badge/Next.js-15%20%7C%2016-black)](https://nextjs.org)

**Production-ready Redis cache handler for Next.js** — seamlessly supports both **legacy ISR** (`cacheHandler`) and the new **`"use cache"`** directive (`cacheHandlers`).

## Highlights

- **Dual Handler Architecture** — Single package covers both `cacheHandler` (ISR/SSG pages) and `cacheHandlers` (React `"use cache"` directive)
- **Tag-based Invalidation** — Full support for `revalidateTag()` and `revalidatePath()` with shared Redis state across instances
- **Build Prewarming** — Automatically pushes static build output into Redis on startup, so the first request is always a cache hit
- **Old Build Cleanup** — SCAN-based cleanup removes stale keys from previous deployments without blocking the event loop
- **Timeout Protection** — Every Redis call is wrapped in a configurable timeout with graceful fallback to cache-miss behavior
- **Concurrent Request Safety** — Deduplicates in-flight `set()` operations so parallel requests don't race against each other

## Installation

```bash
npm install @mirunamu/next-redis-cache
```

**Peer dependencies:**

| Package | Version |
|---------|---------|
| `next` | `>=15.0.0` |
| `@redis/client` | `>=5.0.0` |

> **Note:** This package uses the official [`@redis/client`](https://www.npmjs.com/package/@redis/client) (part of `redis` v5+), not `ioredis`.

## Quick Start

### Step 1 — Legacy Cache Handler

Create `cache-handler.mjs` at your project root:

```js
import { LegacyCacheHandler } from "@mirunamu/next-redis-cache";
import { PHASE_PRODUCTION_BUILD } from "next/constants.js";

const buildId = process.env.BUILD_ID || "default";

LegacyCacheHandler.onCreation(async (context) => {
  if (context.serverOptions?.phase === PHASE_PRODUCTION_BUILD) {
    return null; // skip Redis during build
  }

  if (!process.env.REDIS_URL) {
    return null; // no Redis URL → graceful fallback
  }

  const { createClient } = await import("@redis/client");
  const client = createClient({ url: process.env.REDIS_URL });
  client.on("error", (err) => console.error("[Redis]", err.message));
  await client.connect();

  return {
    client,
    keyPrefix: `myapp:${buildId}:`,
    sharedTagsKey: `_tags`,
    sharedTagsTtlKey: `_tagTtls`,
    revalidatedTagsKey: `_revalidated`,
  };
});

export default LegacyCacheHandler;
```

### Step 2 — `"use cache"` Handler

Create `use-cache-handler.mjs` at your project root:

```js
const buildId = process.env.BUILD_ID || "default";
let handler;

if (
  process.env.NEXT_PHASE === "phase-production-build" ||
  !process.env.REDIS_URL
) {
  // Build time or no Redis → noop handler
  handler = {
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
    refreshTags: () => Promise.resolve(),
    getExpiration: () => Promise.resolve(0),
    updateTags: () => Promise.resolve(),
  };
} else {
  const { createUseCacheHandler } = await import(
    "@mirunamu/next-redis-cache/use-cache"
  );
  const { createClient } = await import("@redis/client");

  const client = createClient({ url: process.env.REDIS_URL });
  client.on("error", (err) => console.error("[Redis]", err.message));
  await client.connect();

  handler = createUseCacheHandler({
    client,
    keyPrefix: `myapp:${buildId}:`,
    useCacheKeyPrefix: `myapp:${buildId}:uc:`,
    sharedTagsKey: `_tags`,
    sharedTagsTtlKey: `_tagTtls`,
    revalidatedTagsKey: `_revalidated`,
    timeoutMs: 5000,
  });
}

export default handler;
```

> **Important:** Both handlers must use the **same `sharedTagsKey`, `sharedTagsTtlKey`, and `revalidatedTagsKey`** values so that `revalidateTag()` from the legacy handler also invalidates `"use cache"` entries and vice versa.

### Step 3 — Next.js Configuration

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheHandler: require.resolve("./cache-handler.mjs"),
  cacheHandlers: {
    default: require.resolve("./use-cache-handler.mjs"),
  },
  cacheMaxMemorySize: 0, // disable in-memory cache, use Redis only
  generateBuildId: async () => process.env.BUILD_ID || "default",
};

export default nextConfig;
```

### Step 4 — Instrumentation (Optional)

Create `src/instrumentation.ts` to enable build prewarming and old-key cleanup:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const buildId = process.env.BUILD_ID || "default";

    const { cleanupOldBuildKeys, registerInitialCache } = await import(
      "@mirunamu/next-redis-cache/instrumentation"
    );

    // Remove keys from previous builds
    if (process.env.REDIS_URL) {
      await cleanupOldBuildKeys({
        redisUrl: process.env.REDIS_URL,
        patterns: [
          { scan: "myapp:*", keepPrefix: `myapp:${buildId}:` },
        ],
      });
    }

    // Push static build output into Redis
    const CacheHandler = (await import("../cache-handler.mjs")).default;
    await registerInitialCache(CacheHandler, { setOnlyIfNotExists: true });
  }
}
```

## Configuration Reference

### LegacyCacheHandler Options

Returned from the `onCreation` hook:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `RedisClientType` | **required** | Connected `@redis/client` instance |
| `keyPrefix` | `string` | `""` | Prefix prepended to all Redis keys (cache data, tags, TTLs) |
| `sharedTagsKey` | `string` | `"__sharedTags__"` | Suffix for the tag-to-cache-key mapping Hash |
| `sharedTagsTtlKey` | `string` | `"__sharedTagsTtl__"` | Suffix for the cache key expiration tracking Hash |
| `revalidatedTagsKey` | `string` | `"__revalidated_tags__"` | Suffix for the tag revalidation timestamps Hash |
| `timeoutMs` | `number` | `5000` | Timeout (ms) for each Redis operation |
| `defaultStaleAge` | `number` | `31536000` (1 year) | Default stale age (seconds) when `revalidate` is not set |
| `estimateExpireAge` | `(staleAge: number) => number` | `s => Math.floor(s * 1.5)` | Calculates the hard expiration age from the stale age |

> **Key composition:** `sharedTagsKey`, `sharedTagsTtlKey`, and `revalidatedTagsKey` are automatically prefixed with `keyPrefix`. For example, `keyPrefix: "myapp:abc:"` + `sharedTagsKey: "_tags"` results in the Redis key `myapp:abc:_tags`. Do **not** include the prefix in these values.

### createUseCacheHandler Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `RedisClientType` | **required** | Connected `@redis/client` instance |
| `keyPrefix` | `string` | `""` | Prefix prepended to tag/TTL Hash keys |
| `useCacheKeyPrefix` | `string` | `"uc:{keyPrefix}"` | Prefix for `"use cache"` data entries |
| `sharedTagsKey` | `string` | `"__sharedTags__"` | Suffix for the tag mapping Hash (prefixed with `keyPrefix`) |
| `sharedTagsTtlKey` | `string` | `"__sharedTagsTtl__"` | Suffix for the expiration tracking Hash (prefixed with `keyPrefix`) |
| `revalidatedTagsKey` | `string` | `"__revalidated_tags__"` | Suffix for the tag revalidation Hash (prefixed with `keyPrefix`) |
| `timeoutMs` | `number` | `5000` | Timeout (ms) for each Redis operation |

### cleanupOldBuildKeys Options

| Option | Type | Description |
|--------|------|-------------|
| `redisUrl` | `string` | Redis connection URL (creates its own client) |
| `patterns` | `CleanupPattern[]` | Array of scan/keep rules |

Each `CleanupPattern`:

| Field | Type | Description |
|-------|------|-------------|
| `scan` | `string` | Redis SCAN pattern (e.g., `"myapp:*"`) |
| `keepPrefix` | `string?` | Keep keys starting with this prefix |
| `keepExact` | `string?` | Keep this exact key |

### registerInitialCache Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `setOnlyIfNotExists` | `boolean` | `true` | Only write if key doesn't exist in Redis (NX flag) |

## API Reference

### Entry Point: `@mirunamu/next-redis-cache`

```ts
import { LegacyCacheHandler } from "@mirunamu/next-redis-cache";
```

**`LegacyCacheHandler`** — Drop-in cache handler for Next.js `cacheHandler` config.

| Method | Signature | Description |
|--------|-----------|-------------|
| `onCreation` | `static onCreation(hook: OnCreationHook): void` | Register an async hook that returns Redis config. Called once at module load time. |
| `get` | `async get(key: string): Promise<CacheHandlerValue \| null>` | Retrieve a cached entry. Returns `null` on miss, timeout, expiry, or tag staleness. |
| `set` | `async set(key: string, data: unknown, ctx?: object): Promise<void>` | Store a cache entry with serialized Buffers, tags, and TTL. |
| `revalidateTag` | `async revalidateTag(tag: string \| string[]): Promise<void>` | Invalidate all cache entries associated with the given tag(s). |

### Entry Point: `@mirunamu/next-redis-cache/use-cache`

```ts
import { createUseCacheHandler } from "@mirunamu/next-redis-cache/use-cache";
```

**`createUseCacheHandler(options)`** — Creates a handler object for Next.js `cacheHandlers.default`.

Returns:

| Method | Signature | Description |
|--------|-----------|-------------|
| `get` | `async get(cacheKey: string, softTags: string[]): Promise<CacheEntry \| undefined>` | Retrieve a `"use cache"` entry. Waits for any in-flight `set()` on the same key. |
| `set` | `async set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>` | Await the pending entry promise, tee the stream, and store in Redis. |
| `refreshTags` | `async refreshTags(): Promise<void>` | No-op for Redis (shared state across instances). |
| `getExpiration` | `async getExpiration(tags: string[]): Promise<number>` | Returns the maximum revalidation timestamp for the given tags, or `0`. |
| `updateTags` | `async updateTags(tags: string[], durations?: object): Promise<void>` | Update tag revalidation timestamps in Redis. |

### Entry Point: `@mirunamu/next-redis-cache/instrumentation`

```ts
import {
  registerInitialCache,
  cleanupOldBuildKeys,
} from "@mirunamu/next-redis-cache/instrumentation";
```

| Function | Return | Description |
|----------|--------|-------------|
| `registerInitialCache(CacheHandler, options?)` | `Promise<{ prewarmed: number }>` | Read `.next/prerender-manifest.json` and push all static routes into Redis. |
| `cleanupOldBuildKeys(options)` | `Promise<{ deleted: number }>` | SCAN Redis for old build keys and delete them in batch. |

## Features

### Tag-based Invalidation

Both handlers share the same tag system through Redis Hashes. When you call `revalidateTag()` or `revalidatePath()` in a Server Action, the cache handler:

1. Records the tag's revalidation timestamp in the `revalidatedTagsKey` Hash
2. Scans all cache entries for keys tagged with that tag
3. Deletes matching cache keys and their tag/TTL registrations

```ts
// app/actions.ts
"use server";
import { revalidateTag } from "next/cache";

export async function updateProduct(id: string) {
  await db.product.update(id, { /* ... */ });
  revalidateTag("product");      // invalidates all entries tagged "product"
  revalidateTag(`product:${id}`); // invalidates entries for this specific product
}
```

Next.js also generates implicit tags (prefixed with `_N_T_`) for path-based invalidation. These are handled automatically — `revalidatePath("/blog")` marks the implicit tag as stale so subsequent `get()` calls return a cache miss.

### TTL & Cache Lifecycle

Each cache entry tracks three timestamps:

| Timestamp | Meaning | Calculation |
|-----------|---------|-------------|
| `staleAt` | Entry becomes stale, triggers background revalidation | `lastModified + revalidate` |
| `expireAt` | Entry is completely removed | `lastModified + estimateExpireAge(revalidate)` |
| Redis `EX` | Redis key TTL (auto-deletion) | `estimateExpireAge(revalidate)` |

The `estimateExpireAge` function determines how long to keep stale entries before hard expiration. The default `s => Math.floor(s * 1.5)` keeps entries 50% longer than their stale age, giving Next.js time for background revalidation.

For the `"use cache"` handler, TTL is calculated from the entry's own timestamps:

```
ttl = max(1, expire - (Date.now() - timestamp) / 1000)
```

You can customize the lifecycle per-route using Next.js `cacheLife()`:

```ts
"use cache";
import { cacheLife } from "next/cache";

export async function getCatalog() {
  cacheLife("hours"); // stale: 1h, revalidate: 1h, expire: 1h
  return db.catalog.findMany();
}
```

### Build Prewarming

`registerInitialCache()` runs during the Next.js instrumentation phase and ensures that all statically generated pages are immediately available in Redis, eliminating cold starts:

1. Reads `.next/prerender-manifest.json` (version 4)
2. For each route, reads the corresponding files from disk:
   - **App Pages**: `.html`, `.rsc`, `.meta`, and `.segments/` directory
   - **App Routes**: `.body` and `.meta`
3. Calls `CacheHandler.set()` with `setOnlyIfNotExists: true` (Redis NX flag) so existing cache entries are not overwritten

```ts
const { prewarmed } = await registerInitialCache(CacheHandler, {
  setOnlyIfNotExists: true,  // default: true
});
console.log(`Prewarmed ${prewarmed} routes`);
```

### Old Build Cleanup

When you deploy a new build with a new `buildId`, previous build keys become orphaned in Redis. `cleanupOldBuildKeys()` removes them:

```ts
await cleanupOldBuildKeys({
  redisUrl: process.env.REDIS_URL!,
  patterns: [
    {
      scan: "myapp:*",                 // scan all keys under myapp:
      keepPrefix: `myapp:${buildId}:`, // keep current build's keys
    },
  ],
});
```

Since all keys (cache data, tags, TTLs, revalidation) share the same `keyPrefix`, a single pattern is sufficient to clean up everything from previous builds.

The cleanup uses `SCAN` with `COUNT 200` to iterate keys without blocking the Redis server, and `DEL` to remove them in batch.

### Concurrent Request Handling

The `"use cache"` handler maintains a `pendingSets` Map that tracks in-flight `set()` operations by cache key. When a `get()` request arrives for a key that is currently being written:

- Instead of returning a cache miss, it **waits** for the pending write to complete
- Then retries the `get()` from Redis

This prevents a common race condition where multiple concurrent requests all experience cache misses and redundantly compute the same value.

### Error Recovery

Every Redis operation is wrapped in a timeout (default: 5000ms). When a timeout or connection error occurs:

- **`get()`** returns `null` (legacy) or `undefined` (use-cache) — treated as a cache miss
- **`set()`** silently fails — the entry is not cached, but the response is still served
- **`revalidateTag()`** logs the error and continues

The handler also checks `client.isReady` before each operation. If the Redis connection is lost, all cache operations gracefully degrade to cache-miss behavior.

Enable debug logging with:

```bash
NEXT_PRIVATE_DEBUG_CACHE=1 npm run start
```

## Redis Key Structure

All Redis keys are composed from `keyPrefix` + suffix. This keeps every key under a single namespace for easy cleanup.

```
# Cache data (String keys with TTL)
{keyPrefix}{cacheKey}                     → ISR page cache (JSON)
{useCacheKeyPrefix}{cacheKey}             → "use cache" entries (base64 JSON)

# Tag management (Hash keys, auto-prefixed with keyPrefix)
{keyPrefix}{sharedTagsKey}                → { cacheKey: JSON(tags[]) }
{keyPrefix}{sharedTagsTtlKey}             → { cacheKey: expireTimestamp }
{keyPrefix}{revalidatedTagsKey}           → { tagName: revalidationTimestamp }
```

**Example** with `keyPrefix: "myapp:abc:"`, `sharedTagsKey: "_tags"`, `revalidatedTagsKey: "_revalidated"`:

```
myapp:abc:/products             → '{"kind":"APP_PAGE","html":"...","rscData":"base64..."}'
myapp:abc:uc:/api/get           → '{"data":"base64...","tags":["product"],"revalidate":3600}'

myapp:abc:_tags                 → { "/products": '["product","catalog"]' }
myapp:abc:_tagTtls              → { "/products": "1707592843" }
myapp:abc:_revalidated          → { "product": "1707592000" }
```

Since all keys share the `myapp:abc:` prefix, a single cleanup pattern `{ scan: "myapp:*", keepPrefix: "myapp:abc:" }` removes all keys from previous builds.

## Example App

The repository includes a full test application with interactive test scenarios.

### Run Locally

```bash
cd test-app
npm install
REDIS_URL=redis://localhost:6379 npm run build && npm run start
```

### Bringing the Handler Files to Your Own Project

To use the cache handlers in your own Next.js app, create the following files based on the [Quick Start](#quick-start) examples:

1. **`cache-handler.mjs`** — Legacy handler setup (change `keyPrefix` to your app name)
2. **`use-cache-handler.mjs`** — `"use cache"` handler setup (use the same tag key suffixes)
3. **`next.config.ts`** — Add `cacheHandler`, `cacheHandlers`, `cacheMaxMemorySize: 0`, and `generateBuildId`
4. **`src/instrumentation.ts`** — Optional: add `cleanupOldBuildKeys()` and `registerInitialCache()`

Replace `myapp` with your own app prefix (e.g., `docs`, `blog`). Ensure both handlers share the same `sharedTagsKey`, `sharedTagsTtlKey`, and `revalidatedTagsKey` values.

### Test Scenarios

| Category | Test | What it verifies |
|----------|------|------------------|
| **Legacy (ISR)** | Basic Fetch | `fetch()` with `revalidate` is cached and served |
| | Fetch Tags | `fetch()` with `tags` option, tag-based invalidation |
| | Multi Tags | Multiple tags on a single entry, selective invalidation |
| | Revalidate Path | `revalidatePath()` invalidates by route path |
| **use cache** | Basic | `"use cache"` function result is cached |
| | Cache Life | `cacheLife()` profiles control TTL |
| | Cache Tag | `cacheTag()` + `revalidateTag()` invalidation |
| | Component | Cached React Server Component |
| | Nested | Nested `"use cache"` calls |
| **Cross-cutting** | TTL Expiry | Cache entries expire after TTL elapses |
| | Concurrent | Parallel requests don't cause duplicate writes |
| | Prewarm * | `registerInitialCache()` populates Redis on startup |
| | Cleanup * | `cleanupOldBuildKeys()` removes old build keys |
| | Reconnect * | Graceful degradation on Redis connection loss |

\* *Requires `REDIS_URL`*

## Compatibility

| Requirement | Version |
|-------------|---------|
| Next.js | 15, 16 |
| `@redis/client` | 5+ |
| Node.js | 18+ |

Works with any deployment target: Vercel, Docker, self-hosted, or any Node.js runtime.

## License

[MIT](LICENSE)
