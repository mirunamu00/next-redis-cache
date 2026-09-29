# @mirunamu/next-redis-cache

## 2.0.0-next.0

### Major Changes

- [`71971bb`](https://github.com/mirunamu00/next-redis-cache/commit/71971bbb7381ae7ebe26473717209a42909aa13f) Thanks [@geonwooo-park](https://github.com/geonwooo-park)! - 2.0: factory handlers with Next.js 16 semantics, build-output fallback, bounded connection handling and registry-based old-build cleanup. See MIGRATION.md for the upgrade from 1.x.

  **Breaking**

  - `LegacyCacheHandler` (static class, `onCreation`) is replaced by `createCacheHandler(config)`; `createUseCacheHandler` takes the same config. Options `keyPrefix`, `useCacheKeyPrefix`, `sharedTagsKey`, `sharedTagsTtlKey`, `revalidatedTagsKey`, `timeoutMs`, `defaultStaleAge` and `estimateExpireAge` are replaced by `namespace` + `buildId`, `timeouts`, `circuitBreaker` and `ttl`.
  - New key layout (`{namespace}:{buildId}:e|u:{key}`, `{namespace}:_tagstate`, `{namespace}:_builds`) and a binary, brotli-compressed entry format: 2.x does not read 1.x entries.
  - `registerInitialCache` is removed (use `prewarmFromBuildOutput` or `startCacheMaintenance({ prewarm: true })`); `cleanupOldBuildKeys` is deprecated.
  - Invalidations no longer delete entries; TTLs count from the write (static pages 30 days, capped at 365 days).
  - `peerDependencies.next` is `^16.1.0`, `engines.node` is `>=20.9.0`.

  **New**

  - Next.js 16 tag semantics in both handlers: `revalidateTag(tag, profile)` is stale-while-revalidate, `updateTag`/`revalidatePath` are read-your-own-writes, `dynamicParams = false` pages never answer 404 because of an invalidation (`onTagExpired`).
  - Build-output fallback: prerendered pages and route handlers are served from `.next/server/app` (read by Next's own file-system cache) when Redis has no entry or is unavailable, and written back to Redis.
  - `@mirunamu/next-redis-cache/redis`: `connectRedis(url, { waitMs })` - bounded first connection, background reconnect, one shared client per URL.
  - Read/write timeouts and a circuit breaker; nothing is sent while the client is not ready.
  - `startCacheMaintenance`, `cleanupOldBuilds`, `prewarmFromBuildOutput`, `whenReady` in `./instrumentation`: keep the current and previous build, remove builds nobody reads, wait for Redis with backoff.
  - `logger` and `onEvent` options, transition-based logging.
  - `compression` (`"brotli"` default, `"gzip"`, `"none"`), optional `tagStateTtlSeconds` (Redis 7.4+), `swr` and `tagStateCacheMs` for `"use cache"`.

## 1.1.0

### Minor Changes

- Hotfix release: fixes for tag invalidation, connection handling, prewarming and old-build cleanup. The Redis key layout is unchanged, so 1.1.0 can run next to 1.0.x instances during a rolling update.

  **Fixes**

  - `revalidateTag(tag, profile)` (for example `"max"`) no longer disables the cache for that tag. `updateTags(tags, durations)` recorded `now + expire` as the tag's revalidation time, so every entry of the tag was a cache miss until then (a year for `"max"`), in both handlers. It now records the current time: the next read regenerates the entry once, later reads are hits. Future times written by 1.0.x are treated as "revalidated now" and rewritten when read, so affected tags recover after one regeneration.
  - The `"use cache"` handler checks that the client is ready before it sends a command. Before, commands were sent first: on a closed client the rejected promises were never handled (`unhandledRejection`, which can terminate the process), and during a reconnect they piled up in the client's offline queue and were replayed against Redis after recovery.
  - `registerInitialCache()` now produces the same entries as Next.js' own file-system cache: segment prefetch data is keyed by the meta `segmentPaths` (`/_tree`, `/about/__PAGE__`; nested segments were dropped before), `/` is stored as `/index`, route handlers (`.body`, e.g. `icon` and OG images) are prewarmed, and the meta `status` (404 for `/_not-found`) and `postponed` state are kept. Prewarmed pages now answer client-side segment prefetches from the cache.
  - `cleanupOldBuildKeys()` deletes with `UNLINK` in batches of at most 500 keys while it scans instead of collecting every key and sending one `DEL`, counts keys matched by several patterns once, closes its client with `destroy()`, and gives up after a connect/command timeout (new `timeoutMs` option, default 5000) with a warning instead of hanging startup when Redis is unreachable. It resolves with the number of keys deleted and does not reject because of Redis.
  - The per-command timeout timer is cleared as soon as the command settles (one 5-second timer was left behind per command).

  **Changes**

  - Errors are logged without `NEXT_PRIVATE_DEBUG_CACHE`: the first failure of an outage is a `console.warn`, further failures are summarized at most once a minute, and the recovery is logged once with `console.info`.
  - Conditional type declarations: `require` resolves to `.d.cts`, `import` to `.d.ts`.
  - `peerDependencies["@redis/client"]` is now `^5.0.0 || ^6.0.0` (was `>=5.0.0`); 6.x is covered by CI. `engines.node` is `>=18.18.0`.
  - README: bounded connection wait in the Quick Start (an unbounded `await client.connect()` stalls every cache call while Redis is unreachable), a Security section, and corrected statements about timeouts, request deduplication, `cacheLife("hours")`, prewarming and cleanup during rolling updates.

## 1.0.6

### Patch Changes

- [`c66b4db`](https://github.com/mirunamu00/next-redis-cache/commit/c66b4dbb7b21860d7362df08986906a159a49475) Thanks [@geonwooo-park](https://github.com/geonwooo-park)! - fix: scanIterator yields key arrays in @redis/client v5, iterate inner keys correctly

## 1.0.5

### Patch Changes

- [`033e61c`](https://github.com/mirunamu00/next-redis-cache/commit/033e61c6df482496c6840db920a1be80d6f03a99) Thanks [@geonwooo-park](https://github.com/geonwooo-park)! - update README.md

## 1.0.4

### Patch Changes

- [`d65279e`](https://github.com/mirunamu00/next-redis-cache/commit/d65279e6e63d2b651237a035703d602ed91b6da9) Thanks [@geonwooo-park](https://github.com/geonwooo-park)! - update README.md

## 1.0.3

### Patch Changes

- [`9f0a913`](https://github.com/mirunamu00/next-redis-cache/commit/9f0a913e560aef3eefb3df62a1f3afa816e92989) Thanks [@geonwooo-park](https://github.com/geonwooo-park)! - chore: remove test application and related files

## 1.0.2

### Patch Changes

- [`654cdc4`](https://github.com/mirunamu00/next-redis-cache/commit/654cdc48591657ea3bc5f8f6a016ddd05ab5e70d) Thanks [@geonwooo-park](https://github.com/geonwooo-park)! - update README.md

## 1.0.1

### Patch Changes

- [`9d644a6`](https://github.com/mirunamu00/next-redis-cache/commit/9d644a63161216cca4b0bfcfd27066b14b8a2675) Thanks [@geonwooo-park](https://github.com/geonwooo-park)! - update README.md

## 1.0.0

### Major Changes

- [`3f48bd7`](https://github.com/mirunamu00/next-redis-cache/commit/3f48bd7258925f9b46d9775288e365c41cb4fcac) Thanks [@geonwooo-park](https://github.com/geonwooo-park)! - Initial release of @mirunamu/next-redis-cache

  - Legacy cache handler (`LegacyCacheHandler`) for Next.js ISR and Route Handlers
  - Use-cache handler (`createUseCacheHandler`) for Next.js `use cache` directive
  - Distributed tag-based invalidation via Redis Hash (`TagManager`)
  - Instrumentation helpers: `registerInitialCache`, `cleanupOldBuildKeys`
  - Stream/Buffer serialization utilities for Redis storage
  - Configurable key prefix, timeout, and Redis client injection
