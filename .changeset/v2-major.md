---
"@mirunamu/next-redis-cache": major
---

2.0: factory handlers with Next.js 16 semantics, build-output fallback, bounded connection handling and registry-based old-build cleanup. See MIGRATION.md for the upgrade from 1.x.

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
