# @mirunamu/next-redis-cache

[![npm version](https://img.shields.io/npm/v/@mirunamu/next-redis-cache.svg)](https://www.npmjs.com/package/@mirunamu/next-redis-cache)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)

**Production-ready Redis cache handler for Next.js** — seamlessly supports both **legacy ISR** (`cacheHandler`) and the new **`"use cache"`** directive (`cacheHandlers`).

## Highlights

- **Dual Handler Architecture** — Single package covers both `cacheHandler` (ISR/SSG pages) and `cacheHandlers` (React `"use cache"` directive)
- **Tag-based Invalidation** — `revalidateTag()`, `updateTag()` and `revalidatePath()` with tag state shared across instances in Redis
- **Build Prewarming** — `registerInitialCache()` pushes the prerendered build output (pages, route handlers, segment prefetch data) into Redis during the instrumentation phase
- **Old Build Cleanup** — `cleanupOldBuildKeys()` removes keys of previous deployments with SCAN and batched UNLINK, bounded by a timeout
- **Fail-safe Cache Commands** — Handler commands have a timeout (`timeoutMs`) and are never sent while the client is disconnected; failures become cache misses and are logged once per outage
- **Read-after-write in Process** — A `"use cache"` read waits for an in-flight `set()` of the same key in the same process

## Installation

```bash
npm install @mirunamu/next-redis-cache
```

**Peer dependencies:**

| Package         | Version    |
| --------------- | ---------- |
| `next`          | `>=15.0.0` (16 is the tested and supported line, see [Compatibility](#compatibility)) |
| `@redis/client` | `^5.0.0 \|\| ^6.0.0` |

> **Note:** This package uses the official [`@redis/client`](https://www.npmjs.com/package/@redis/client) (part of `redis` v5+), not `ioredis`.

## Quick Start

### Step 1 — Legacy Cache Handler

Create `cache-handler.mjs` at your project root:

```js
import { LegacyCacheHandler } from "@mirunamu/next-redis-cache";

const buildId = process.env.BUILD_ID || "default";

LegacyCacheHandler.onCreation(async (context) => {
  // The onCreation hook receives { serverDistDir, dev } — not the full Next.js context.
  // Use process.env to detect the build phase.
  if (
    process.env.NEXT_PHASE === "phase-production-build" ||
    !process.env.REDIS_URL
  ) {
    return null; // skip Redis during build or when no URL is provided
  }

  const { createClient } = await import("@redis/client");
  const client = createClient({ url: process.env.REDIS_URL });
  client.on("error", (err) => console.error("[Redis]", err.message));
  // Wait at most 1s for the first connection and keep connecting in the background.
  // See "Connection Handling" below - do not await connect() without a bound.
  await Promise.race([
    client.connect().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);

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
  // Same bounded wait as in cache-handler.mjs
  await Promise.race([
    client.connect().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);

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

> **Set `useCacheKeyPrefix` explicitly** (as above). Its default is `"uc:" + keyPrefix`, which puts `"use cache"` entries _outside_ your `keyPrefix` namespace, so a cleanup pattern such as `myapp:*` would never match them.

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

    // Remove keys from previous builds (see "Old Build Cleanup" about rolling updates)
    if (process.env.REDIS_URL) {
      await cleanupOldBuildKeys({
        redisUrl: process.env.REDIS_URL,
        patterns: [{ scan: "myapp:*", keepPrefix: `myapp:${buildId}:` }],
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

| Option               | Type                           | Default                    | Description                                                 |
| -------------------- | ------------------------------ | -------------------------- | ----------------------------------------------------------- |
| `client`             | `RedisClientType`              | **required**               | Connected `@redis/client` instance                          |
| `keyPrefix`          | `string`                       | `""`                       | Prefix prepended to all Redis keys (cache data, tags, TTLs) |
| `sharedTagsKey`      | `string`                       | `"__sharedTags__"`         | Suffix for the tag-to-cache-key mapping Hash                |
| `sharedTagsTtlKey`   | `string`                       | `"__sharedTagsTtl__"`      | Suffix for the cache key expiration tracking Hash           |
| `revalidatedTagsKey` | `string`                       | `"__revalidated_tags__"`   | Suffix for the tag revalidation timestamps Hash             |
| `timeoutMs`          | `number`                       | `5000`                     | Timeout (ms) for each Redis operation                       |
| `defaultStaleAge`    | `number`                       | `31536000` (1 year)        | Default stale age (seconds) when `revalidate` is not set    |
| `estimateExpireAge`  | `(staleAge: number) => number` | `s => Math.floor(s * 1.5)` | Calculates the hard expiration age from the stale age       |

> **Key composition:** `sharedTagsKey`, `sharedTagsTtlKey`, and `revalidatedTagsKey` are automatically prefixed with `keyPrefix`. For example, `keyPrefix: "myapp:abc:"` + `sharedTagsKey: "_tags"` results in the Redis key `myapp:abc:_tags`. Do **not** include the prefix in these values.

### createUseCacheHandler Options

| Option               | Type              | Default                  | Description                                                         |
| -------------------- | ----------------- | ------------------------ | ------------------------------------------------------------------- |
| `client`             | `RedisClientType` | **required**             | Connected `@redis/client` instance                                  |
| `keyPrefix`          | `string`          | `""`                     | Prefix prepended to tag/TTL Hash keys                               |
| `useCacheKeyPrefix`  | `string`          | `"uc:{keyPrefix}"`       | Prefix for `"use cache"` data entries                               |
| `sharedTagsKey`      | `string`          | `"__sharedTags__"`       | Suffix for the tag mapping Hash (prefixed with `keyPrefix`)         |
| `sharedTagsTtlKey`   | `string`          | `"__sharedTagsTtl__"`    | Suffix for the expiration tracking Hash (prefixed with `keyPrefix`) |
| `revalidatedTagsKey` | `string`          | `"__revalidated_tags__"` | Suffix for the tag revalidation Hash (prefixed with `keyPrefix`)    |
| `timeoutMs`          | `number`          | `5000`                   | Timeout (ms) for each Redis operation                               |

### cleanupOldBuildKeys Options

| Option      | Type               | Description                                                                                      |
| ----------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| `redisUrl`  | `string`           | Redis connection URL (creates its own client, closed when done)                                  |
| `patterns`  | `CleanupPattern[]` | Array of scan/keep rules                                                                         |
| `timeoutMs` | `number?`          | Connect timeout and per-command timeout in ms (default `5000`); the cleanup gives up after it |

Each `CleanupPattern`:

| Field        | Type      | Description                            |
| ------------ | --------- | -------------------------------------- |
| `scan`       | `string`  | Redis SCAN pattern (e.g., `"myapp:*"`) |
| `keepPrefix` | `string?` | Keep keys starting with this prefix    |
| `keepExact`  | `string?` | Keep this exact key                    |

### registerInitialCache Options

| Option               | Type      | Default | Description                                        |
| -------------------- | --------- | ------- | -------------------------------------------------- |
| `setOnlyIfNotExists` | `boolean` | `true`  | Only write if key doesn't exist in Redis (NX flag) |

## API Reference

### Entry Point: `@mirunamu/next-redis-cache`

```ts
import { LegacyCacheHandler } from "@mirunamu/next-redis-cache";
```

**`LegacyCacheHandler`** — Drop-in cache handler for Next.js `cacheHandler` config.

| Method          | Signature                                                                  | Description                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onCreation`    | `static onCreation(hook: OnCreationHook): void`                            | Register an async hook that returns Redis config. Called once at module load time.                                                                       |
| `get`           | `async get(key: string, ctx?: object): Promise<CacheHandlerValue \| null>` | Retrieve a cached entry. Returns `null` on miss, timeout, expiry, or tag staleness. The optional `ctx` may contain `softTags` for implicit tag checking. |
| `set`           | `async set(key: string, data: unknown, ctx?: object): Promise<void>`       | Store a cache entry with serialized Buffers, tags, and TTL.                                                                                              |
| `revalidateTag` | `async revalidateTag(tag: string \| string[], durations?: { expire?: number }): Promise<void>` | Invalidate all cache entries associated with the given tag(s). `durations` is accepted but ignored in 1.x (entries are deleted). |

### Entry Point: `@mirunamu/next-redis-cache/use-cache`

```ts
import { createUseCacheHandler } from "@mirunamu/next-redis-cache/use-cache";
```

**`createUseCacheHandler(options)`** — Creates a handler object for Next.js `cacheHandlers.default`.

Returns:

| Method          | Signature                                                                           | Description                                                                      |
| --------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `get`           | `async get(cacheKey: string, softTags: string[]): Promise<CacheEntry \| undefined>` | Retrieve a `"use cache"` entry. Waits for any in-flight `set()` on the same key. |
| `set`           | `async set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>`     | Await the pending entry promise, tee the stream, and store in Redis.             |
| `refreshTags`   | `async refreshTags(): Promise<void>`                                                | No-op for Redis (shared state across instances).                                 |
| `getExpiration` | `async getExpiration(tags: string[]): Promise<number>`                              | Returns the latest revalidation time (ms) of the given tags, or `0`. Never a future time. |
| `updateTags`    | `async updateTags(tags: string[], durations?: { expire?: number }): Promise<void>`  | Records the current time as the tags' revalidation time (see Tag-based Invalidation). |

### Entry Point: `@mirunamu/next-redis-cache/instrumentation`

```ts
import {
  registerInitialCache,
  cleanupOldBuildKeys,
} from "@mirunamu/next-redis-cache/instrumentation";
```

| Function                                       | Return                           | Description                                                                 |
| ---------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `registerInitialCache(CacheHandler, options?)` | `Promise<{ prewarmed: number }>` | Read `.next/prerender-manifest.json` and push every prerendered App Router page and route handler into Redis. |
| `cleanupOldBuildKeys(options)`                 | `Promise<{ deleted: number }>`   | SCAN Redis for old build keys and UNLINK them in batches of 500. Never rejects because of Redis; resolves with the number of keys deleted. |

## Features

### Tag-based Invalidation

The two handlers use different invalidation strategies, but share the `revalidatedTagsKey` Redis Hash for tag revalidation timestamps.

#### Legacy Handler (`revalidateTag`)

The legacy handler performs **eager invalidation** — it scans and deletes cache entries immediately:

1. Scans the `sharedTagsKey` Hash to find all cache keys tagged with the given tag
2. Deletes matching cache keys and their tag/TTL registrations
3. For **implicit tags only** (`_N_T_` prefix, generated by `revalidatePath()`), also records a revalidation timestamp in `revalidatedTagsKey`

> **Note:** For explicit tags (e.g., `"product"`), the legacy handler does **not** record a timestamp — it relies solely on scan-and-delete. The `sharedTagsKey` and `sharedTagsTtlKey` Hashes are only used by the legacy handler; the use-cache handler does not register entries in them.

#### Use-cache Handler (`updateTags`)

The use-cache handler performs **lazy invalidation** — it records timestamps, and staleness is checked on read:

1. Records the current time as the tag's revalidation timestamp in `revalidatedTagsKey` (for all tags)
2. On subsequent `get()` calls, compares the entry's `timestamp` against the tag's revalidation timestamp
3. If the tag was revalidated after the entry was stored, the entry is a miss and Next.js regenerates it

`revalidateTag(tag, profile)` (for example `"max"`) and `updateTag(tag)` behave the same way in 1.x: the next read of an older entry regenerates it once, later reads are hits. Next.js' in-memory default handler instead serves the old entry once while it regenerates (stale-while-revalidate); that needs a second timestamp per tag and is planned for 2.0.

> **Upgrading from 1.0.x:** 1.0.x recorded `now + expire` for `revalidateTag(tag, profile)`, which made every entry of that tag a miss until that future time (a year for `"max"`). 1.1 treats a stored time more than a minute in the future as "revalidated now" and rewrites it, so such tags recover after one regeneration.

```ts
// app/actions.ts
"use server";
import { revalidateTag } from "next/cache";

export async function updateProduct(id: string) {
  await db.product.update(id, {
    /* ... */
  });
  revalidateTag("product"); // invalidates all entries tagged "product"
  revalidateTag(`product:${id}`); // invalidates entries for this specific product
}
```

When `revalidateTag()` is called in a Server Action, Next.js dispatches it to both handlers: `LegacyCacheHandler.revalidateTag()` and the use-cache handler's `updateTags()`.

Next.js also generates implicit tags (prefixed with `_N_T_`) for path-based invalidation. `revalidatePath("/blog")` marks the implicit tag as stale so subsequent `get()` calls return a cache miss.

### TTL & Cache Lifecycle

Each cache entry tracks three timestamps:

| Timestamp  | Meaning                                               | Calculation                                         |
| ---------- | ----------------------------------------------------- | --------------------------------------------------- |
| `staleAt`  | Entry becomes stale, triggers background revalidation | `lastModified + revalidate`                         |
| `expireAt` | Entry is completely removed                           | `lastModified + estimateExpireAge(staleAge)`        |
| Redis `EX` | Redis key TTL (auto-deletion)                         | `expireAt - now` (remaining seconds until expireAt) |

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
  cacheLife("hours"); // stale: 5m, revalidate: 1h, expire: 1d
  return db.catalog.findMany();
}
```

### Build Prewarming

`registerInitialCache()` is designed to be called from your `instrumentation.ts` during the Next.js startup phase. It reads build output and pushes prerendered routes into Redis, so they are served from Redis without a render after a deployment:

1. Reads `.next/prerender-manifest.json` (version 4)
2. For each route, reads the files the way Next.js' own file-system cache does, under Next's cache key (`/` is stored as `/index`):
   - **App Pages**: `.html`, `.meta` (status, headers, postponed state, segment paths), `.rsc` (not for partially prerendered pages), and every segment listed in the meta (`.segments/<path>.segment.rsc`, keyed like `/_tree`), so client-side segment prefetches are cache hits
   - **App Routes** (route handlers such as `icon` or OG images): `.body` and `.meta` (status, headers)
   - The not-found page (`/_not-found`) keeps its 404 status
3. Calls `CacheHandler.set()` with `setOnlyIfNotExists: true` (Redis NX flag) so existing cache entries are not overwritten

Pages Router output is not prewarmed.

```ts
const { prewarmed } = await registerInitialCache(CacheHandler, {
  setOnlyIfNotExists: true, // default: true
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
      scan: "myapp:*", // scan all keys under myapp:
      keepPrefix: `myapp:${buildId}:`, // keep current build's keys
    },
  ],
});
```

Since all keys (cache data, tags, TTLs, revalidation) share the same `keyPrefix`, a single pattern is sufficient to clean up everything from previous builds (with `useCacheKeyPrefix` inside it, see Step 2).

The cleanup iterates with `SCAN` (`COUNT 200`) and deletes with `UNLINK` in batches of at most 500 keys while it scans, so memory stays bounded and no single command blocks Redis for long. Keys matched by several patterns are deleted and counted once. The cleanup opens its own connection with a connect timeout and no reconnect attempts; if Redis is unreachable or a command exceeds `timeoutMs`, it logs a warning and resolves with the keys deleted so far instead of hanging your startup.

> **Rolling updates:** while a new build starts, instances of the previous build are still serving. Keeping only the current build (`keepPrefix` = the current build's prefix) deletes the previous build's keys immediately, so those instances start missing (and `dynamicParams = false` pages without a cache entry answer 404). Run the cleanup only after the old instances are gone, or keep the previous build's prefix as well.

### Concurrent Request Handling

The `"use cache"` handler maintains a `pendingSets` Map that tracks in-flight `set()` operations by cache key. When a `get()` request arrives for a key that is currently being written **in the same process**:

- Instead of immediately returning a cache miss, it **waits** for the pending write to complete
- Then proceeds to read the entry from Redis (a single read, not a retry)

This only covers a read that arrives while a write of the same key is in flight in this process. It does not deduplicate renders across requests or instances — deciding when to render is up to Next.js.

### Error Recovery

Cache commands issued by the handlers have a timeout (`timeoutMs`, default 5000ms), and the handlers check `client.isReady` **before** sending a command: while the client is disconnected or reconnecting nothing is sent (and nothing piles up in the client's offline queue to be replayed after recovery). When a command is skipped, times out or fails:

- **`get()`** returns `null` (legacy) or `undefined` (use-cache) — treated as a cache miss
- **`set()`** fails — the entry is not cached, but the response is still served
- **`revalidateTag()`** / **`updateTags()`** fail for that call and the handler continues

Failures are always logged, without flooding the logs: the first failure of an outage is a `console.warn` (`[next-redis-cache] ...`), further failures are summarized at most once a minute, and the recovery is logged once with `console.info`.

Not covered by `timeoutMs`: connecting the client (your code decides how long to wait, see Connection Handling) and `cleanupOldBuildKeys()` (its own `timeoutMs` option).

Enable debug logging with:

```bash
NEXT_PRIVATE_DEBUG_CACHE=1 npm run start
```

### Connection Handling

The handlers never connect the client themselves; they use the client you return from `onCreation` or pass to `createUseCacheHandler`. With `@redis/client`'s default reconnect strategy, `await client.connect()` does **not** settle while Redis is unreachable — and the legacy handler waits for your `onCreation` hook, so an unbounded `await` there stalls every cache call (and your pages) until Redis comes back.

Bound the wait instead, as the Quick Start does:

```js
// Required: an "error" event without a listener crashes the process
client.on("error", (err) => console.error("[Redis]", err.message));
await Promise.race([
  client.connect().catch(() => {}),
  new Promise((resolve) => setTimeout(resolve, 1000)),
]);
```

Until the client is ready, every cache call is a fast miss (nothing is sent); once it connects, the cache is used again.

## Security

Anyone who can write to the Redis database decides what your site serves: cache entries contain the complete HTML, RSC payloads and route handler responses that Next.js sends to users. Treat Redis write access like deploy access.

- Require authentication (`requirepass` or ACL users) and keep Redis on a private network; use TLS (`rediss://`) when traffic leaves a trusted network.
- Do not share the database with untrusted tenants or applications. `keyPrefix` separates namespaces; it is not an access boundary — use ACL key patterns if you need one.
- Cache entries are parsed as JSON only (no code is evaluated), but their content is served as-is.

## Redis Key Structure

All Redis keys are composed from `keyPrefix` + suffix. This keeps every key under a single namespace for easy cleanup.

```
# Cache data (String keys with TTL)
{keyPrefix}{cacheKey}                     → ISR page cache (JSON)
{useCacheKeyPrefix}{cacheKey}             → "use cache" entries (base64 JSON; default prefix "uc:{keyPrefix}")

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

## Getting Started

To use the cache handlers in your own Next.js app, create the following files based on the [Quick Start](#quick-start) examples:

1. **`cache-handler.mjs`** — Legacy handler setup (change `keyPrefix` to your app name)
2. **`use-cache-handler.mjs`** — `"use cache"` handler setup (use the same tag key suffixes)
3. **`next.config.ts`** — Add `cacheHandler`, `cacheHandlers`, `cacheMaxMemorySize: 0`, and `generateBuildId`
4. **`src/instrumentation.ts`** — Optional: add `cleanupOldBuildKeys()` and `registerInitialCache()`

Replace `myapp` with your own app prefix (e.g., `docs`, `blog`). Ensure both handlers share the same `sharedTagsKey`, `sharedTagsTtlKey`, and `revalidatedTagsKey` values.

## Compatibility

| Requirement     | Version                                                            |
| --------------- | ------------------------------------------------------------------ |
| Next.js         | 16 (tested: 16.1, 16.3)                                            |
| `@redis/client` | 5.x, 6.x (tested: 5.x end to end, 6.x with the integration suite)  |
| Redis server    | tested: 7.2, 8.4                                                   |
| Node.js         | `>=18.18` (`engines`; tested: 22, 24)                              |

Next.js 15 is still admitted by the peer range of 1.x but is not tested, and its `"use cache"` handler interface (`expireTags`, variadic `getExpiration`) differs from what `createUseCacheHandler` implements — use the `"use cache"` handler with Next.js 16 only.

Works with any deployment target: Vercel, Docker, self-hosted, or any Node.js runtime.

## License

[MIT](LICENSE)
