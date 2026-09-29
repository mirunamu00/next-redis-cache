# @mirunamu/next-redis-cache hardening roadmap

This document is the **source of truth** for hardening the package. Every work session reads it first and updates it when a decision changes.
It is not part of the npm package (`files` in `package.json` is `dist` only - enforced by `scripts/check-pack.mjs`).

- Written: 2026-09-29 (1.0.6 audit -> plan -> test environment redesign, merged into one document)
- Versions: 1.0.6 (published) -> 1.1.0 (hotfix, released from master - section 11) -> 2.0.0 (P2..P6 done on `feat/v2`, ready for `2.0.0-next.N` - section 12)
- Reference consumer: the `mirunamu-cluster/docs` app (docs.mirunamu.info). **All verification happens in this repository's test environment**; docs only does rollout smoke tests.
- Language: everything in this repository is English - code, comments, strings, test names, Markdown, commit messages (2026-09-29 user decision, see 6.1). The branch history was rewritten to English on 2026-09-29 (user decision, Q20).

---

## 1. Current state (1.0.6)

| Item | Content |
|---|---|
| Public API | `.` -> `LegacyCacheHandler` (named + default), types `LegacyHandlerConfig`, `OnCreationHook`, `RedisHandlerOptions`, `ResolvedRedisOptions` / `./use-cache` -> `createUseCacheHandler` / `./instrumentation` -> `registerInitialCache`, `cleanupOldBuildKeys` |
| peer | `next >=15.0.0`, `@redis/client >=5.0.0` (no dependencies) |
| Build | tsup ESM `.js` + CJS `.cjs` + `.d.ts`/`.d.cts`, target node18. The exports `types` condition points at `.d.ts` unconditionally |
| Tests | **none** (the test app was deleted in 1.0.3) |
| Publishing | changesets/action + `NPM_TOKEN`. npm 1.0.6 = repo 1.0.6 = docs install (byte-identical to the local dist) |
| Usage | 4,398 npm downloads/month (2026-08-29..09-27) - more than docs CI explains -> external users likely |

### 1.1 Modules and behavior

- `legacy-handler.ts` - CacheHandler class with static state. `onCreation(hook)` registers -> initialized once on first call. get: GET -> restore Buffers -> `HEXISTS` orphan check -> `lifespan.expireAt` check -> `HMGET revalidated` tag check. set: `SET EX [NX]` + `HSET tags` + `HSET ttl` via `Promise.all` (not atomic). revalidateTag: `HSCAN` the whole tag hash, UNLINK matching keys, record a time only for implicit tags (`_N_T_`).
- `use-cache-handler.ts` - factory. get: wait for a pending set -> GET -> miss if `now > timestamp + revalidate*1000` -> HMGET soft/entry tags (2 calls). set: tee -> base64 -> `SET EX`. `updateTags`: with durations records `now + expire*1000`.
- `tag-manager.ts` - 3 hashes (`{prefix}{sharedTagsKey}` cacheKey -> tag JSON, `{prefix}{sharedTagsTtlKey}` cacheKey -> expiry seconds, `{prefix}{revalidatedTagsKey}` tag -> ms). None has a TTL.
- `instrumentation.ts` - `registerInitialCache` (prerender-manifest v4 -> disk -> `set NX`), `cleanupOldBuildKeys` (SCAN -> collect everything in memory -> one `DEL`).
- `redis-client.ts` - `assertClientReady` (isReady only), `withTimeout` (Promise.race, timer never cleared).
- Errors are logged only with `NEXT_PRIVATE_DEBUG_CACHE`.

### 1.2 Next.js interface facts (verified in source)

- Next 16.1.6 = 16.3.6 `CacheHandler`: `get(key, softTags)`, `set(key, pendingEntry)`, `refreshTags()`, `getExpiration(tags[])`, `updateTags(tags, durations?)`.
- Next 15.5.26 `CacheHandlerV2`: `getExpiration(...tags)` (variadic), `expireTags(...tags)` - no `updateTags` -> **the package's use-cache handler does not work correctly on Next 15.**
- `revalidateTag(tag, profile)` (16): `revalidation-utils.js` calls `updateTags(tags, {expire: cacheLife.expire})` ('max' = 1 year). Without a profile `updateTags(tags)` (immediate expiry).
- Default handler semantics: `updateTags(durations)` = `stale=now`, `expired=now+expire*1000`. `areTagsExpired`: `expired <= now && expired > ts`. `areTagsStale`: `stale > ts`. Its `getExpiration` returns `expired` (a future time after a profile update).
- use-cache SWR: `use-cache-wrapper.js` regenerates in the background after responding when it gets an entry past revalidate (before expire). The 16.3.6 default handler returns `revalidate:-1` for stale tags; a negative `expire` marks eviction.
- Legacy SWR: if the handler returns `lastModified:-1`, `IncrementalCache` sets isStale=-1 -> response-cache serves the old value + regenerates in the background. **Returning null makes `dynamicParams=false` routes 404** (the docs production incident).
- If `getExpiration` returns `Infinity`, Next leaves implicit tags to `get(softTags)`.

---

## 2. Audit - issue list (7-1 .. 7-15)

| ID | Severity | Problem | Evidence (1.0.6) |
|---|---|---|---|
| 7-1 | high | `revalidateTag(tag,'max')` -> `updateTags(durations)` records a **future time** (`now+1y`) -> every use-cache and legacy entry of that tag is stale/deleted for a year (cache effectively off). Shared hash, so legacy `isStale` is polluted too | `tag-manager.ts:196-198`, `use-cache-handler.ts:107-122`, `tag-manager.ts:66-80` |
| 7-2 | high | With the README's `await client.connect()` (v5 reconnects forever) a Redis outage means the hook never finishes -> **every get/set waits forever**. `cleanupOldBuildKeys` has no connect timeout either. Hook exceptions are outside the try and propagate to Next | `legacy-handler.ts:148,201,277`, `instrumentation.ts:252`, README |
| 7-3 | medium | The use-cache path does `exec(client.get(...))` - **sends first**, checks isReady afterwards. While reconnecting the offline queue grows without bound; with a closed socket the rejected promise is dropped without a handler -> **unhandledRejection -> process exit** | `use-cache-handler.ts:78-81,96,191`, `tag-manager.ts:29-32`, `@redis/client client/index.js:638-640` |
| 7-4 | medium | Prewarm: (1) segment Map keys differ from Next (`_tree`, `about/__PAGE__` vs `/_tree`, `/about/__PAGE__`) -> prefetch 204 (2) `/` is looked up as `app/.html` and skipped (3) routes without `dataRoute` are skipped, so the APP_ROUTE branch is dead code (4) meta `status` and `postponed` are lost | `instrumentation.ts:126,135,63,208,88-89` |
| 7-5 | medium | Values expire via EX but tag/TTL hash fields stay forever. `cleanupExpired` and `deleteTags` have no callers. `revalidateTag` scans the whole hash O(N) + JSON.parse (one broken field aborts everything) | `tag-manager.ts:55,127,97-115` |
| 7-6 | medium | Legacy `revalidateTag` ignores `durations` and deletes immediately -> mismatch with Next 16 SWR, `dynamicParams=false` 404 risk. Explicit tags get no timestamp -> old data can come back when invalidated during a render | `legacy-handler.ts:350-369` |
| 7-7 | medium | Every error log is behind the debug flag -> failed sets and invalidations are silent in production | `legacy-handler.ts:266-268,345-347,365-367` |
| 7-8 | medium | Next 15 compatibility (README, peer) is claimed but unverified and the interface actually differs (1.2) | `package.json:42`, README |
| 7-9 | low-medium | `cleanupOldBuildKeys`: collects everything in memory then one `DEL` (blocking; contradicts the README's non-blocking claim), double counting, deprecated `disconnect()`, `keepPrefix` deletes the old pods' keys during a rolling update | `instrumentation.ts:255-279` |
| 7-10 | low | `withTimeout` never clears its timer -> one 5 s timer left per call, delays shutdown | `redis-client.ts:15-20` |
| 7-11 | low | APP_ROUTE ignores `ctx.cacheControl` -> on Next 16 always the default 1 year x 1.5 TTL. use-cache discards past revalidate but keeps the TTL at expire (useless data stays). TTL is based on lastModified, so re-seeding an old build expires immediately | `legacy-handler.ts:101`, `use-cache-handler.ts:98-102,183-186` |
| 7-12 | low | The three set commands are not atomic, and the hashes are overwritten even when NX skipped. A get on another pod between the value write and HSET can delete the value as orphaned. Overlapping sets of one key: the first set's finally clears the second set's pending marker | `legacy-handler.ts:335-342`, `use-cache-handler.ts:196-197` |
| 7-13 | low | README inaccuracies: exaggerated in-flight dedup, "every call has a timeout", default `uc:` prefix outside keyPrefix, wrong `cacheLife("hours")` values, App Route prewarm does not work, no `LICENSE` file, no security note (Redis write access = cache poisoning), actions pinned by tag | README |

### 2.1 Found in P0c..P0d

- **Prerendered routes 404 on an empty Redis (A2)**: 1.0.6 + Redis up + no keys -> `dynamicParams=false` pages 404 (Next gets null -> NoFallbackError). Same path as the docs prewarm dependency and incident. Even with prewarm on, `dynamicParams=false` pages still 404 after an invalidation (7-6), after key loss (C6) and after a cleanup during a rolling update (C11, C12).
- **A segment prefetch miss is a 404 on 16.3.6** (the "204" in section 1 and 7-4 was an older version). Wrong prewarm key format -> 404; entries Next rendered and stored itself -> 200.
- **Prewarm skips every route starting with `/_`** (`/_not-found`) - the "not-found status lost" part of 7-4 is really "not prewarmed at all".
- **7-3 also happens with the default reconnecting client**: a 3 s Redis outage under traffic -> 165..171 unhandledRejections. Presumably some of the promises the handler sent before the ready check are rejected when the reconnect fails (the rest stay in the offline queue and are replayed after recovery; 3..22 observed).
- **Legacy class type incompatibility**: `LegacyCacheHandler` is not assignable to the class type Next constructs with `CacheHandlerContext` (index signature of its own context type). Part of 7-8, tracked by contract-types with `@ts-expect-error`.
- `@redis/client` **6.2.1 is out**. peer `>=5.0.0` admits unverified 6.x (section 9 risk; resolved in P1, D14).

### 2.2 Found in the production check of 2.0.0-next.0 (P5, docs master c943f3c)

The check itself passed (59/59 paths 200 and HIT, segment prefetch 200/HIT, no warn/error, pod stable, keys `docs:<build>:e:*` brotli envelopes with ~30-day TTLs, `used_memory` 133 MB). Two findings, fixed before 2.0.0 (reproduced first, then fixed):

| ID | Severity | Problem | Evidence | Fix |
|---|---|---|---|---|
| 7-14 | low | `connectRedis` logged the first connection after its `waitMs` warning as a reconnection: "docs: not connected within 1000ms; connecting in the background" -> "cleanup: waiting for Redis" -> "docs: connected to redis://... again" | production log; `tests/unit/redis.test.ts` "[7-14]", `tests/fault/repro-connection.test.ts` (real socket) | 3b23b5f - "again" only after the client had been ready |
| 7-15 | low-medium | `startCacheMaintenance` ran the cleanup once per process: "cleanup: deleted 0 keys; kept c943f3c (current), 45545a4 (previous); deferred (recently used) a20e5cb; TTL capped on 58 keys" - the deferred build was never looked at again by that pod, its keys only went away through the one-day TTL cap. Real Redis confirms the suspected amplifier: the TTL cap's EXPIRE refreshes OBJECT IDLETIME (TTL, OBJECT and SCAN do not), so a build capped as "previous" at one start looks used at the next start when deployments come closer together than `minIdleSeconds` | production log; integration "EXPIRE refreshes OBJECT IDLETIME ..." and "[7-15] a build deferred because of the TTL cap ..." (Redis 7.2 and 8.4), fault `maintenance-rechecks.test.ts`, chaos C15 | d202c0c - rechecks (D57), unified keep set (D58) |

---

## 3. Goals and acceptance criteria

**Goal**: implement both Next 16 cache interfaces with correct semantics, answer static pages without 404 through Redis failures, latency, absence and eviction, bound Redis memory, and pin all of it with in-repo regression tests. Shrink the docs wrapper (526 lines) to configuration.

**Non-goals**: ioredis, Redis Cluster/Sentinel, advanced Pages Router features, Edge runtime, use-cache on Next 15.

| # | Acceptance criterion | Measured by |
|---|---|---|
| A1 | 7-1..7-12 each have a test that fails on 1.0.6 and passes on 2.0 | vitest `it.fails` -> regular |
| A2 | Start without Redis -> first response < 2 s, every prerendered route 200 | static-site e2e + chaos C1 |
| A3 | Latency while Redis is unresponsive: first call <= readTimeout, <= 50 ms extra while the circuit is open | chaos C3 |
| A4 | Zero `unhandledRejection` across all fault injections, no offline-queue burst after recovery | fault + chaos |
| A5 | After 10 simulated deployments keys <= (kept builds x pages) + tags; only `_tagstate` and `_builds` have no TTL | integration + fleet |
| A6 | Segment prefetch 200 for every prewarmed/re-seeded page | static-site e2e |
| A7 | After `revalidateTag(t,'max')` the next request is a stale response + one regeneration, then hits. `updateTag(t)` is an immediate miss | full-cc / full-legacy e2e |
| A8 | Two instances on a shared Redis: an invalidation on one is visible on the other's next request | fleet e2e |
| A9 | Redis memory for one build down >= 50% (compression option) | static-site perf |
| A10 | docs cache code <= ~40 lines, `resilient-cache-handler.mjs`, `redis-connect.mjs`, `build-keys.mjs` removed | docs PR |

---

## 4. Version strategy

- **1.1.0 hotfix first** (schema unchanged): 7-1 (record now), 7-3 (thunk execution), 7-4 (segment keys, `/index`, APP_ROUTE, status), 7-9 (batched UNLINK, `destroy`, connect timeout), 7-10 (`clearTimeout`), always-on warn logging, LICENSE, exports types. Immediate benefit for external users + a real test of the OIDC publishing pipeline.
- **2.0.0 major**: key schema and storage format, options (`keyPrefix` -> `namespace` + `buildId`, drop `sharedTagsKey`/`sharedTagsTtlKey`), factory API (no static class), peer `next ^16.1`, `@redis/client ^5`, `engines.node >=20.9`, new instrumentation API.
- **Zero-downtime switch**: value keys are build-scoped, so a new image uses a new key space (coexists with old v1 pods). v2 keys keep `{ns}:{buildId}:...` (second segment = owner) so v2 cleanup removes old v1 build keys (`docs:<sha>:/about`) with the same rule. Build-independent global keys use the reserved `_` owner (`{ns}:_builds`, `{ns}:_tagstate`) and are never cleaned up. The stored envelope carries a format version; unknown versions are misses.
- Risk: rolling back to a v1 image after the switch, the v1 docs cleanup (`build-keys.mjs`) treats `_tagstate` as an old build and deletes it after 30 min idle - harmless for docs (no tag invalidation), to be documented.

---

## 5. Target architecture (2.0)

### 5.1 Key schema

| Key | Type | TTL | Content |
|---|---|---|---|
| `{ns}:{build}:e:{cacheKey}` | String (binary envelope) | always | legacy entry |
| `{ns}:{build}:u:{cacheKey}` | String (binary envelope) | always | use-cache entry |
| `{ns}:_tagstate` | Hash, two fields per tag: `s:<tag>` stale, `x:<tag>` expired (ms) - planned: tag -> `"{stale},{expired}"` | none (bounded by tag count); optional per-field HEXPIRE on Redis >= 7.4 (`tagStateTtlSeconds`) | tag state shared by both handlers |
| `{ns}:_builds` | ZSET | none | build registry |

- **No tag -> key reverse index, lazy invalidation only** (same as Next's default handler) -> 7-5 solved structurally.
- Tag state is **namespace-global** (a data invalidation must also apply to old-build pods).
- Envelope: `[magic+ver][meta JSON length][meta JSON][blob...]` - Buffers and segment Maps without base64, optional gzip/brotli. Reads use `withTypeMapping({[RESP_TYPES.BLOB_STRING]: Buffer})`.
- (as built, D21) Two hash fields per tag instead of one `"{stale},{expired}"` value: every update is one idempotent HSET that leaves the other field untouched, exactly like Next's partial updates (`{...existing, expired: now}`), without a read-modify-write.
- (as built, `src/envelope.ts`) header `"NRC"` + format version (1) + flags (bits 0-1 compression) | body `uint32 meta length | meta JSON {m, v, b} | blobs`. Buffers/Uint8Arrays and strings >= 1 KiB are blobs (raw bytes, no base64, no JSON escaping); Maps are `{"$nrc":"m"}`; an object that has a `$nrc` key is wrapped. Compression (payload >= 1 KiB) covers the body: gzip, or brotli at quality 4 (D28). Unknown magic/version/corruption -> `EnvelopeFormatError` -> miss.

### 5.2 Semantics (Next 16)

- `updateTags(tags, durations?)` = legacy `revalidateTag(tags, durations?)` = one function: no durations -> `expired=now`; durations -> `stale=now, expired=now+expire*1000`. Both handlers write an idempotent HSET. **No key deletion.**
- Tag checks port Next's `areTagsExpired`/`areTagsStale` as-is.
- use-cache `get`: `expire<0` (eviction mark), `now > ts+expire*1000` or an expired tag -> miss / stale tag -> `revalidate:-1` / only revalidate passed -> returned as-is (Next SWR). `swr:false` keeps the current behavior.
- `getExpiration` -> `Infinity` (implicit tags checked once in `get(softTags)`). Confirmed with 16.1 and 16.3 fixtures.
- Legacy `get`: with softTags, GET+HMGET pipelined -> HMGET for the remaining stored tags (at most 2 round trips). FETCH + expired -> null. APP_PAGE/APP_ROUTE/PAGES expired or stale -> `lastModified:-1` (SWR). Option `onTagExpired:"stale"|"miss"` (default stale). Remove the HEXISTS orphan check and the `lifespan.expireAt` check.
- TTL: **from the write time**. Numeric revalidate -> `estimateExpire(revalidate)` (default x1.5), `false` -> `ttl.staticSeconds` (default 30 days), everything capped at `ttl.maxSeconds`. APP_ROUTE reads `ctx.cacheControl`.
- `pendingSets` tracked per set with a token. No `tee` when storing to Redis.
- **As built (P2..P6), differences from the plan above:**
  - Implicit (soft) tags of a use-cache `get` use the use-cache wrapper's `getExpiration` rule (`timestamp <= max(expired)`, future `expired` included), not `areTagsExpired`/`areTagsStale` - that is what Next does with the default handler, and the oracle (fixed + random programs, with and without durations) agrees (D23). Entry tags use `areTagsExpired`/`areTagsStale` as-is.
  - Legacy entries with an **expired** tag: `onTagExpired: "auto"` (new default, D43) answers a miss (Next renders before answering, like its own FileSystemCache) except for a prerendered path of a `dynamicParams = false` route (prerender-manifest `dynamicRoutes[srcRoute].fallback === false`), where a miss is a 404 and `lastModified: -1` is returned; without a manifest it behaves like `"stale"`. `"stale"` / `"miss"` force one answer. **Stale** tags (profiles) always return `lastModified: -1`. Found by the nightly e2e matrix: Next 16.1 serves a `-1` entry once and regenerates in the background (`STALE`), Next 16.3 treats `-1` as "expired, regenerate before answering" (`REVALIDATED`, response-cache comment), so `updateTag` was not read-your-own-writes on 16.1 with `-1`.
  - FETCH with a stale tag also returns `lastModified: -1` (Next computes `isStale` from the age).
  - A legacy entry stores the time of the miss / stale answer that triggered its render as `lastModified` (the render start), not the time of `set` (D22): an invalidation that lands during a slow render leaves the result stale (C13, 7-6). The mark lives 5 min per key (10k keys max), the earliest pending miss wins; time-stale hits (stored `revalidate` elapsed) are marked too.
  - The HEXISTS orphan check and `lifespan` are gone; the second round trip (entry tags) is skipped when the request already named them.

### 5.3 Connection, timeouts, circuit, logging

- Every command goes through one `run(op, () => client.cmd(...))`: circuit open or `!isReady` -> **nothing is sent**, unavailable. Timeout with a cleared timer (whether to also use the client's command `timeout` option is decided after checking). One timeout -> open for `openMs`.
- `client` is an instance or `() => client|null`. The package never awaits `connect()`. `./redis` provides `connectRedis(url,{waitMs=1000})` (returns the client late at the latest, logs disconnect/recover transitions). One shared client via a globalThis symbol.
- `logger` option (default console warn/error, debug with `NEXT_PRIVATE_DEBUG_CACHE`), logging only on transitions + periodic summaries. `onEvent` hook (hit/miss/stale/fallback/reseed/error/circuit).
- Default `disabled` = `NEXT_PHASE === "phase-production-build"` -> built-in no-op.
- **As built:** the client's own command `timeout` option only covers the time before a command is written to the socket (`commands-queue.js` removes it from `toWrite`), so the package bounds the whole round trip with its own race (cleared timer) and does not use the option (D24). The circuit breaker is keyed by the client object (WeakMap), shared by every handler using that client; only timeouts open it, command errors (WRONGTYPE, OOM) do not (D25). A client function is awaited at most 3 s per call (`CLIENT_RESOLVE_MS`); the first client it returns is kept, `null` is asked again next time and logged once as info (D26). `reportFailure` does not treat `no-client`/`disabled` as failures. The default logger looks console methods up per call (log shippers that patch console after startup, and test spies, see the lines).

### 5.4 Build-output (disk) fallback

- APP_PAGE and APP_ROUTE, when `!dev && !disabled && serverDistDir`. Uses Next's `FileSystemCache` read-only (`flushToDisk:false`, `maxMemoryCacheSize:0`) - follows the Next version's format automatically. The internal path dependency is guarded by a dynamic import + matrix contract tests.
- Disk entries are also checked against tag state: stale -> `lastModified:-1`, fresh -> NX re-seed (revalidate from prerender-manifest, `/` -> `/index`).
- Prewarm is rewritten on the same path (7-4 solved structurally). With fallback + re-seed, prewarm is optional and off by default.
- **As built (`src/build-output.ts`):** `FileSystemCache` is loaded with a variable specifier through `import()` (ESM gets `module.exports` as `default`, CJS gets the class; both handled), constructed with `{ fs: ctx.fs ?? node fs, serverDistDir, flushToDisk: false, maxMemoryCacheSize: 0 }`; if it cannot be loaded the fallback is off with one warning. States: `fresh` (served with the file mtime, re-seeded NX in the background, once per key in flight, revalidate from the manifest, only prerendered routes), invalidated (answered like an expired/stale Redis entry), `unknown` (Redis unusable: served as it is, no re-seed). Only for `ctx.kind` APP_PAGE/APP_ROUTE, not in dev, not while disabled. Prewarm (`prewarmFromBuildOutput`) reads through the same class with `isRoutePPREnabled = meta.postponed != null` (D40), SET NX with the file mtime as lastModified; returns `{prewarmed, skipped, failed, unavailable?}`. The matrix contract is `tests/contract/runtime/fallback.contract.mjs`, run by `contract-types.mjs` inside each variant's install (16.1 and 16.3 pass).
- Next bundles `instrumentation.ts` at build time, including the package's `./instrumentation` entry: a new package version needs a new app build for maintenance changes (`prepare-app --hot-dist` only refreshes the runtime-loaded handlers).

### 5.5 Old-build cleanup

Port of the docs `build-keys.mjs` algorithm: registry ZSET, keep the current + N previous builds, delete others with batched UNLINK only when every key has `OBJECT IDLETIME >= minIdleSeconds`, cap the TTL of held and previous builds, `cleanupWhenReady` (wait for ready + exponential backoff). `_*` owners excluded. v1 `cleanupOldBuildKeys` stays (fixed) and is deprecated in 2.x, removed in 3.0.

As built (`src/maintenance.ts`): `cleanupOldBuilds(client, opts)` (rejects on Redis errors), `whenReady(client, task, retry)` (the docs `cleanupWhenReady`, generic; never rejects; `{gaveUp:false, attempts, value}` or `{gaveUp:true, attempts, cause: "disconnected"|"error", error}`), `startCacheMaintenance({config, cleanup, prewarm})` (resolves the client from the config, `{skipped: "disabled"|"no-client"}` otherwise, runs cleanup and prewarm through `whenReady`, one log line each, never rejects). Reserved owners are `_*` **except** the 1.x tag hash names (`__sharedTags__`, `__sharedTagsTtl__`, `__revalidated_tags__`, `_tags`, `_tagTtls`, `_revalidated`), which 2.x never reads and cleans like old builds (D44). SCAN MATCH escapes glob characters of the namespace.

### 5.6 Public API draft

```ts
// "@mirunamu/next-redis-cache"
export interface RedisCacheConfig {
  client: RedisClientType | (() => RedisClientType | null | Promise<RedisClientType | null>);
  namespace: string;                                   // required
  buildId?: string;                                    // default process.env.BUILD_ID ?? <distDir>/BUILD_ID
  timeouts?: { readMs?: number; writeMs?: number };    // default 1000 / 2000
  circuitBreaker?: { openMs?: number } | false;        // default { openMs: 10_000 }
  fallback?: { buildOutput?: boolean; reseed?: boolean } | false; // default true/true (prod)
  ttl?: { staticSeconds?: number; maxSeconds?: number; estimateExpire?: (revalidateSec: number) => number };
                                                       // default 30 days / 365 days / s => Math.floor(s*1.5)
  onTagExpired?: "stale" | "miss";                     // default "stale"
  compression?: "none" | "gzip" | "brotli";            // default "none" (re-evaluated in P6)
  logger?: Partial<Record<"debug"|"info"|"warn"|"error", (...a: unknown[]) => void>> | false;
  onEvent?: (e: CacheEvent) => void;
  disabled?: boolean | (() => boolean);                // default: build phase
}
export function createCacheHandler(config: RedisCacheConfig): new (ctx: unknown) => LegacyCacheHandlerInstance;
// "@mirunamu/next-redis-cache/use-cache"
export function createUseCacheHandler(config: RedisCacheConfig & { swr?: boolean; tagStateCacheMs?: number }): CacheHandler;
// "@mirunamu/next-redis-cache/redis"
export function connectRedis(url: string | undefined, o?: { waitMs?: number; label?: string; clientOptions?: RedisClientOptions; logger?: Logger }): Promise<RedisClientType | null>;
// "@mirunamu/next-redis-cache/instrumentation"
export function startCacheMaintenance(o: { config: RedisCacheConfig;
  cleanup?: { keepPrevious?: number; minIdleSeconds?: number; retiredTtlSeconds?: number; attempts?: number } | false; // 1 / 1800 / 86400 / 10
  prewarm?: boolean | { concurrency?: number } /* default false */ }): { done: Promise<MaintenanceResult> };
export function cleanupOldBuilds(client: RedisClientType, o: CleanupOptions): Promise<CleanupResult>;
export function prewarmFromBuildOutput(config: RedisCacheConfig, o?: { concurrency?: number }): Promise<{ prewarmed: number; skipped: number; failed: number }>;
/** @deprecated */ export function cleanupOldBuildKeys(...): ...;
```

**As built (2.0.0-next), differences from the draft:**

- `RedisCacheConfig` adds `tagStateTtlSeconds?: number` (P6, HEXPIRE); `onTagExpired` is `"auto" | "stale" | "miss"`, default `"auto"` (D43); `compression` default is `"brotli"` (D42). `buildId` default also reads `<distDir>/BUILD_ID` via `ctx.serverDistDir`, else `<cwd>/.next/BUILD_ID`, else `"default"` with one warning.
- `createCacheHandler` returns `LegacyCacheHandlerClass` = `new (ctx?: LegacyHandlerContext) => LegacyCacheHandlerInstance`; the types avoid index signatures so Next's `CacheHandlerContext` class type accepts it (7-8, contract-types).
- `./redis` also exports `closeSharedClients()`; `connectRedis` options add `shared` (default true).
- `./instrumentation` also exports `whenReady(client, task, retry)` and the result types; `startCacheMaintenance` retry options (`attempts`, `baseDelayMs`, `maxDelayMs`) sit inside `cleanup` / `prewarm`; `prewarm` also takes `distDir`; `MaintenanceResult` is `{ skipped?, cleanup?: Attempted<CleanupResult>, prewarm?: Attempted<PrewarmResult> }`.
- `registerInitialCache` and the static `LegacyCacheHandler` (named and default export) are removed (D27). The default export of `.` is gone.

### 5.7 docs wrapper (P5)

| docs code | Handling |
|---|---|
| Disk fallback, tag check + `lastModified:-1`, NX re-seed, circuit for unresponsive Redis (`cache/resilient-cache-handler.mjs`) | absorbed |
| Recording explicit tag times, own `withTimeout` | dropped (replaced by v2) |
| `connectRedis`, `isBuildPhase` (`cache/redis-connect.mjs`) | absorbed |
| Registry cleanup, `cleanupWhenReady` (`cache/build-keys.mjs`) | absorbed. The docs log formatter is docs' choice |
| Missing REDIS_URL banner (`src/instrumentation-node.ts`) | stays in docs |
| Background cleanup/prewarm coordination | absorbed (`startCacheMaintenance`) |
| use-cache no-op (`use-cache-handler.mjs`) | absorbed |
| `tests/unit/*`, `mini-redis.mjs` | ported to the package (P0), deleted from docs together with the wrapper |

docs end state: `cache/config.mjs` (namespace, BUILD_ID, `connectRedis`, `CACHE_NAMESPACE` override) + 3 lines per handler file + the instrumentation banner and `startCacheMaintenance({prewarm:false})`. Exact version pin during prereleases (`2.0.0-next.N`), `^2.0.0` after the stable release. The exact files are in section 12.3.

---

## 6. Test environment (in the repo, committed)

### 6.1 Layout

```
next-redis-cache/
|- package.json              # the published package. files:["dist"], no workspaces
|- tsconfig.json             # editor + typecheck (all) / tsconfig.build.json (src only) / tests are in tsconfig.json
|- tsup.config.ts  eslint.config.mjs  vitest.config.ts  playwright.config.ts (P0c)
|- stryker.config.mjs  vitest.mutation.config.ts (P0e)  .size-limit.json  .gitattributes  .nvmrc  LICENSE  ROADMAP.md
|- src/
|- tests/
|  |- support/               # redis factory, namespace/DB allocation, waitFor, toxiproxy client, mini-redis,
|  |                         # handlers (drive handlers directly), repro (reproduction convention), quarantine (P0d~)
|  |- unit/  property/  integration/  fault/
|  |- contract/{types,oracle}/
|  |- e2e/{static-site,full-legacy,full-cc}/ + fixtures.ts
|  |- chaos/ (harness.ts + scenarios)  perf/baseline/
|  `- fixtures/next-build/   # part of a Next 16.3.6 build output for the 7-4 prewarm reproductions
|- test-apps/
|  |- static-site/  full-legacy/  full-cc/  _shared/
|  `- _variants/{next-16.1,next-16.3,canary}/   # per-version package.json (+lock)
|- scripts/                  # all Node .mjs
|  |- check-pack.mjs  check-no-hangul.mjs  quality.mjs  coverage-summary.mjs  (P0a)
|  |- infra.mjs  test-all.mjs  (P0b)
|  |- lib/{run,pack-rules,hangul-rules,work}.mjs
|  |- pack.mjs  prepare-app.mjs  origin-server.mjs  fleet.mjs  contract-types.mjs   (P0c)
|  |- perf.mjs   (P0d)
|  |- check-quarantine.mjs  junit-summary.mjs  mutation-summary.mjs  nightly-issue.mjs   (P0e)
|  `- check-commit-messages.mjs   (P1)
|- docker/
|  |- compose.yml            # profiles: redis84, redis72, prodlike, toxiproxy, replica
|  |- redis/prodlike.conf
|  `- toxiproxy/proxies.json
`- .github/workflows/{ci.yml, chaos.yml (reusable), nightly.yml, release.yml}
```

- Changes vs. plan: there is no `ci-matrix.mjs` - the matrix is computed inside ci.yml with `fromJSON(inputs.level == 'full' && ... || ...)`. `tests/perf/scenarios/` does not exist; the two scenarios live in `scripts/perf.mjs`.
- Added in 2.0 (P2..P6): `src/{config,keys,logger,runner,envelope,tag-state,tag-writer,ttl,build-output,prewarm,maintenance,legacy-cleanup,redis,redis-entry}.ts` (1.x `buffer-utils`, `error-reporter`, `redis-client`, `tag-manager` removed); `tests/support/fake-redis.ts` (in-memory client for unit tests); `tests/fault/maintenance.test.ts`; `tests/integration/{prewarm,maintenance}.test.ts`; `tests/chaos/{degraded,persistence,pressure}.test.ts`; `tests/contract/runtime/fallback.contract.mjs`; `scripts/lib/readme-blocks.mjs`; `MIGRATION.md`. e2e `repro.spec.ts` files are now `regressions.spec.ts` (no expected failures left).

- No npm workspaces (per-app Next version conflicts, symlink problems). Test apps are independent npm projects assembled by root scripts.
- Publish isolation: `files:["dist"]` + `check-pack.mjs` compares the `npm pack --dry-run --json` list with a whitelist of `dist/**`, `README.md`, `LICENSE`, `package.json` (PR gate). Files referenced by exports, main, module or types that are missing also fail.
- **English only.** (1) 2026-09-29, first user decision: every non-`.md` file (src, tests, test-apps, scripts, docker, workflows, configs) must be free of Hangul (U+1100-U+11FF, U+3130-U+318F, U+AC00-U+D7AF), including comments, JSDoc, strings and test names. (2) 2026-09-29, second user decision (this is a public, international npm package): **Markdown and commit messages are English too.** `check-no-hangul.mjs` now scans every tracked file plus untracked files that are not ignored, Markdown included, so it catches problems before a commit; it runs in `quality` and the CI static job. `check-commit-messages.mjs` (CI static job) fails when any commit message in `origin/master..HEAD` contains Hangul. At the user's request the earlier Korean commit messages on `feat/test-infra` were rewritten to English (trees unchanged) and force-pushed, so no cutoff is needed.

### 6.2 How the test apps consume the package

- **Install the `npm pack` tarball** (no symlinks): identical to a real consumer (exports, files, ESM/CJS), peers `next`/`@redis/client` resolve inside the app -> one Next instance, standalone tracing works.
- Avoiding lock conflicts: the variant `package.json` does not list the package; `npm ci`, then `npm i --no-save <tgz>`. After installing, `npm ls next @redis/client` must show one version each.
- Fast local iteration `--hot-dist`: **copy** the new `dist` into `.work/<app>/node_modules/.../dist` (CI always uses the tarball).
- Baseline mode `--pkg npm:1.0.6`: run the same scenario with the published package (P0d reproductions and baselines).
- Next matrix: `_variants/next-16.1` and `next-16.3` commit a lock; app sources are shared and `prepare-app` **copies** them into `.work/<app>@<variant>/` (avoids Windows symlink permissions). canary has no lock, nightly only, allowed to fail. Dependabot updates the variant locks.
- **P0c implementation details (final)**
  - Pinned variants (latest patches on 2026-09-29): `next-16.1` = next 16.1.7 + react/react-dom 19.2.8, `next-16.3` = next 16.3.6 + react 19.3.0, both `@redis/client` 5.12.1. canary = `next@canary` + `react@latest`, no lock.
  - `pack.mjs`: working tree -> `.artifacts/nrc-local.tgz` (`--no-build` uses the existing dist), `npm:<version>` -> `.artifacts/nrc-npm-<version>.tgz` (downloaded once, reused).
  - `prepare-app.mjs <app|all> --variant --pkg local|npm:1.0.6|x.tgz --build A[,B] --api v1 --hot-dist --no-pack`: skips `npm ci` when the variant lock hash is unchanged, skips reinstalling when the tarball hash is unchanged, installs the tarball by relative path with `npm install --no-save`. Checks with `npm ls next @redis/client --all` that each has exactly one version. A build moves `.next/standalone` to `builds/<id>/`, copies `.next/static`, `public` and `_shared`, and writes `nrc-build.json` (app, variant, buildId, api, next, package version).
  - `next build` is **spawned asynchronously** - the origin server lives in the same process, and `spawnSync` froze its fetches during the build (the build actually failed with a use-cache fill timeout).
  - next.config pins `outputFileTracingRoot` and `turbopack.root` to the app directory (so the repo root's package-lock.json is not mistaken for a workspace root). Next writes the standalone `cacheHandler` path relative to distDir, so moving it to `builds/<id>/` works.
  - Windows: right after a build, opening the new files (static-site ~3,300) for the first time took 193 s because of Defender scans and the first start exceeded the fleet readiness timeout (120 s). `prepare-app` reads every file once right after the build to absorb that cost (instant with a Defender exclusion for `.work/`). Not an issue on Linux CI.

### 6.3 Test apps

Common: `output:"standalone"`, `generateBuildId=BUILD_ID`, `cacheMaxMemorySize:0`, `cacheHandler` + `cacheHandlers.default/remote` = the `_shared` handlers, `NRC_API=v1|v2` adapter, env `TEST_NS` and `REDIS_URL`, started with `node .next/standalone/server.js`.

Observability (only with `TEST_HOOKS=1`): every response carries `data-build`, `data-render-id` (UUID), `data-rendered-at`, `data-instance`; `/api/__test/stats` (onEvent counters), `/api/__test/unhandled` (unhandledRejection count). **origin server**: `GET /data/:key?delay=ms` (returns a version, counts calls), `POST /data/:key` (bumps the version), `GET /hits`.

- **static-site** (docs pattern): `/docs/[...slug]` ~120 pages with `dynamicParams=false`, nested layouts and route groups, seeded 200..500 KB bodies / `/`, `/about`, `not-found` / `/api/og/docs/[...slug]` force-static PNGs (~50) / `icon.tsx` / `instrumentation.ts`.
- **full-legacy** (cacheComponents off): `/isr/[id]` revalidate=2, `/pinned/[id]` dynamicParams=false + tagged fetch, `/fetch-tags`, route handlers (force-static, revalidate=5), server actions (`revalidateTag` without profile / 'max' / {expire}, `revalidatePath`), `/race/[k]` (invalidation while the origin is slow).
- **full-cc** (cacheComponents on): `"use cache"` + `cacheTag` + `cacheLife('hours')`, custom `short` {revalidate:2, expire:10}, `"use cache: remote"`, PPR page (`postponed` preserved), `updateTag` action, segment prefetch targets.
- Why separate apps: on Next 16 cacheComponents cannot be combined with `export const revalidate/dynamic` - **confirmed in the first P0c build**.
- **P0c findings and implementation details (final)**
  - **cacheComponents constraint confirmed**: a full-cc (16.3.6) page with `export const revalidate = 60` -> `Route segment config "revalidate" is not compatible with nextConfig.cacheComponents. Please remove it.`, `export const dynamic = "force-dynamic"` -> the same error (`"dynamic"`). The apps stay separate.
  - The apps are written in **JS (.jsx/.mjs)** (plan: TS). The variants need no typescript, installs and builds are lighter; contract-types checks the types.
  - Test hook paths are `/api/nrc-test/stats` and `/api/nrc-test/unhandled` - folders starting with `_` such as `__test` are App Router private folders and do not become routes.
  - The `NRC_API=v1` adapters (`_shared/cache-handler.mjs`, `use-cache-handler.mjs`) use **the 1.0.x README Quick Start wiring as-is** (`await client.connect()` inside onCreation, top-level await for use-cache). Reproductions must see what real users see, so the wiring must be the documented one. Counters are added only by subclassing/wrapping. `NRC_API=v2` is filled in P2 (an explicit error for now).
  - instrumentation flags: `NRC_PREWARM=1` (README Step 4 `registerInitialCache`, awaited), `NRC_CLEANUP=1` (`cleanupOldBuildKeys` keepPrefix = own build, awaited). e2e defaults: prewarm on for static-site and full-legacy - on 1.0.6 `dynamicParams=false` pages 404 on an empty Redis (itself the A2 reproduction).
  - 2.0 (P3, D29): `NRC_API` defaults to `v2` - `_shared/config.mjs` `v2Config()` is the 2.x README wiring (one config, `client: () => connectRedis(REDIS_URL)`), used by both handlers and the instrumentation; `v1` needs a 1.x package (`--pkg npm:1.1.0 --api v1`, baselines). v2 flags: `NRC_PREWARM=1` awaits `prewarmFromBuildOutput(config)` (so tests start warm), `NRC_CLEANUP=1` starts `startCacheMaintenance` in the background (`NRC_CLEANUP_MIN_IDLE`), tuning `NRC_READ_MS`, `NRC_WRITE_MS`, `NRC_OPEN_MS`, `NRC_FALLBACK=0`, `NRC_RESEED=0`, `NRC_COMPRESSION`, `NRC_TAG_CACHE_MS`, `NRC_CONNECT_WAIT_MS`, `TEST_CLOCK_OFFSET_MS` (C14). `/api/nrc-test/stats` adds `events` (onEvent counts, `fallback:<state>`, `miss:<reason>`, `circuit:<state>`) and `maintenance` (prewarm / cleanup results).
  - Marker: with TEST_HOOKS=1, `<div id="nrc-test" data-build data-render-id data-rendered-at data-instance>`. With cacheComponents `Date.now()`/`randomUUID()` cannot be used outside a cache scope, so full-cc puts the marker inside a `"use cache"` component (= when the cache entry was created).
  - static-site body text is 100..250 KB per page (HTML is about 2x because of the inlined RSC -> 200..500 KB). 200..500 KB of text at first made HTML up to 1 MB and one build ~200 MB in Redis - too heavy for local iteration.
  - full-cc: short-lived caches (`short`, expire 10 s < 5 min) and `"use cache: remote"` drop out of the static shell, so they sit inside `<Suspense>`. Cached components in the PPR shell do not fetch the origin (in-flight fetches when the prerender stops at a dynamic hole were reported as "Filling a cache during prerender timed out"). `/dyn/[id]` (use-cache lookup on every request) was added for chaos and perf.
  - full-legacy `/pinned/[id]` uses ids 1..6 to isolate tests.
  - Server actions are invoked without a browser by submitting the JS-less form (the hidden `$ACTION_ID_*` field as multipart POST) -> e2e needs no Playwright browser (CI skips the chromium install).

### 6.4 Infrastructure

- **docker compose** (`docker/compose.yml`, host ports overridable by env)
  - `redis84` (default, `redis:8.4`, `requirepass test`), `redis72` (lower bound without HEXPIRE)
  - `prodlike`: mimics production (`helm-chart/mirunamu/redis/values.yaml`) - AOF everysec + RDB save, `volatile-lru`, `requirepass`, maxmemory switched between 16mb/384mb by a compose command argument
  - `toxiproxy`: proxy in front of `redis84` and `prodlike`; tests call the control API on 8474 over HTTP (latency/jitter, timeout, reset_peer, bandwidth, limit_data)
  - `replica` (optional): only mimics replication (failover is a non-goal)
  - default bridge + port mapping (no `network_mode: host` - unsupported on Windows)
- **Split**: testcontainers = integration (self-contained per file, random ports, parameterized versions) / compose = e2e, chaos, perf, fault (toxiproxy), manual debugging.
- **P0b implementation details (final)**
  - Compose project name `nrc`. Default host ports: redis84 `6384`, redis72 `6372`, prodlike `6390`, replica `6391`, toxiproxy API `8474`, static proxies `26384` (-> redis84) and `26390` (-> prodlike). Each can be overridden with `NRC_*_PORT`.
  - `infra:up` default profiles = redis84, redis72, toxiproxy. Pass profiles as arguments, e.g. `npm run infra:up -- prodlike`; `all` starts everything. prodlike belongs to both `prodlike` and `replica` (the replica's primary). `infra:down` removes every profile + volumes.
  - toxiproxy isolation: each vitest worker creates its own proxy `nrc_w<poolId>` on port `26399+poolId` (mapped 26400-26415 -> **at most 16 workers**). Test files inside one worker run sequentially, so a proxy is never shared concurrently. The global `/reset` is never used in parallel tests.
  - Redis versions: `NRC_REDIS_VERSIONS` (comma list, default `8.4,7.2`). CI uses one per cell.
  - testcontainers pinned to `~12.0.4` - 12.1+ declares `engines.node >=22.22` and warns on the local Node 22.21. Can be lifted once local Node is 22.22+.
  - The mini-redis TS port stores values binary-safe (Buffer), adds `AUTH` (password option), `PTTL`, `SET PX`, `DBSIZE`, `HGETALL`, `FLUSHDB`, plus `connectionCount()` and `getBuffer()`. It speaks RESP2 only (no `HELLO`).
- **Multiple instances and rolling updates** (`scripts/fleet.mjs`, P0c): two builds with BUILD_ID A/B, 2..3 instances (get-port, `INSTANCE_ID`, shared Redis through toxiproxy), built-in round-robin LB, rolling A->B (`maxSurge 1, maxUnavailable 0`) and rollback B->A, shutdown with tree-kill.
  - Implementation (vs. plan): no get-port/tree-kill dependencies - ports come from `listen(0)`, and `node server.js` is spawned directly without a shell, so killing the child is enough (SIGTERM, SIGKILL after 5 s). Readiness = `/api/nrc-test/stats` 200 (default 120 s). The LB adds `x-nrc-upstream` to responses. Instances that exit on their own are listed in `fleet.crashed` (I2). `stop()` removes the namespace's keys with SCAN+UNLINK (kept with `NRC_KEEP_KEYS=1`) - without it the local Redis reached 1.5 GB after a few e2e runs. Instance logs go to `.work/logs/<app>@<variant>/<ns>/<id>.log`.
  - P3 (D30): the LB counts in-flight requests per instance; `rolling()` and `stopInstance()` stop routing, wait for them (<= 10 s), then stop the process (endpoint removal + graceful termination). Without it, once 2.x removed the 404s, C11/C12 showed harness-made 502s for requests killed mid-flight.
- **Windows**: all scripts are Node, `.gitattributes` eol=lf, short `.work` path, testcontainers over the Docker Desktop npipe. **GitHub Windows runners cannot run Linux containers** -> Windows CI runs only the layers that need no Docker.

### 6.5 Test layers

| Layer | Tool | Purpose | Budget | Trigger |
|---|---|---|---|---|
| unit | vitest `unit`, fake clock | keys, envelope, TTL, tag checks, circuit, logger | <30s | PR (Node 22/24, Windows) |
| property | fast-check | envelope round trip, TTL monotonic and capped, tag checks == Next reference | <30s | PR |
| integration | testcontainers Redis 7.2/8.4 | command semantics, NX, TTL (`PTTL` ranges), eviction, cleanup, 10k-key batches | <3m | PR |
| fault | mini-redis + toxiproxy | before connect, disconnect, reconnect, unresponsive, latency, reset_peer; zero unhandledRejection, no offline-queue burst | <3m | PR (the mini-redis part on Windows too). vitest project `fault` (mini-redis, no Docker) + `fault-docker` (files `*.docker.test.ts`, needs compose toxiproxy) |
| contract-types | tsc per version | `satisfies next/.../cache-handlers/types#CacheHandler` | <1m/version | PR (16.1/16.3), nightly (canary) |
| contract-oracle | vitest + fast-check | apply operation sequences to Next's `createDefaultCacheHandler` and ours (`swr:false`) and diff | <1m | PR |
| e2e | Playwright + 2-instance fleet | HTML, RSC, segment prefetch, SWR, propagation across instances, zero 404, sitemap 200 | <8m/cell | PR 16.3 x 8.4 x 3 apps / nightly all |
| chaos | long-running vitest + fleet + toxiproxy | C1..C15, invariants I1..I5 | <15m | nightly, before a release |
| perf | autocannon | hit p50/p99, Redis round trips per request, memory of one build | <10m | nightly (deterministic metrics on PR) |
| mutation | Stryker (vitest runner) | quality of the core module tests | <60m | weekly |

**chaos**: C1 Redis absent at startup, C2 killed under traffic, C3 unresponsive, C4 latency 300 ms + jitter, C5 reset_peer, C6 FLUSHALL, C7 eviction pressure (16mb), C8 AOF restart (tag state rolls back), C9 wrong password, C10 WRONGTYPE, C11 rolling A->B, C12 rollback B->A, C13 invalidation during a slow render, C14 clock skew (`TEST_CLOCK_OFFSET_MS`), C15 (P7, 7-15) an old build still read during a rollout is removed by the rechecks without another deployment.

**All 14 exist since 2.0 (21 tests, all regular)**: `startup` C1, C9 · `outage` C2, C5 · `degraded` C3 (30 s downstream latency toxic = connection open, no replies; a dropping `timeout` toxic would desynchronize the RESP pipeline, D35), C4, C10 (`_tagstate` holds a string) · `data-loss` C6, C13 · `persistence` C8 (prodlike `docker compose restart`, graceful AOF) · `pressure` C7 (prodlike `CONFIG SET maxmemory 6mb` - one brotli build is ~17 MB, so 16mb no longer forces eviction), C14 (second instance 3 s behind) · `rolling` C11, C12 (+ registry and TTL-cap assertions), C15 (P7; the rolling fleet runs with `NRC_CLEANUP_MIN_IDLE=3`; fails on the published 2.0.0-next.0, passes with d202c0c). C3's A3 check compares medians (open circuit vs healthy) instead of single requests (D34).

**Invariants**: I1 zero 404/5xx on prerendered routes, I2 zero abnormal exits and unhandledRejections, I3 latency bound, I4 hits resume within 10 s after recovery, I5 with a healthy Redis no old data is served as fresh after an invalidation.

**perf gate**: deterministic metrics (round trips per request = `INFO commandstats` delta, legacy hit <= 2 and use-cache hit <= 2 / `MEMORY USAGE` sum of one build within +5% of the baseline) are a hard PR gate. Timing (p50/p99) is the median of 3 nightly runs; above +20% of the baseline only warns.

**P0c..P0d implementation details (final)**

- **Reproduction (expected failure) convention** - a reproduction asserts the *correct* behavior and is registered as an expected failure. Once fixed the test passes -> the runner fails with "expected to fail but passed" -> the fixing commit must remove the marker to be green.
  - vitest: `itRepro("7-x", "...", fn)` (`tests/support/repro.ts`, `it.fails` inside) -> replaced by `it("[7-x] ...")` when fixed.
  - Playwright: first line `repro("7-x", "reason")` (`test.fail`) -> deleted when fixed.
  - tsc (contract-types): `// @ts-expect-error [7-x] ...` -> fails with "Unused @ts-expect-error" when fixed, so it is deleted.
  - With `NRC_REPRO=show` all three run as regular tests and print the actual failures (reproduction evidence). Remaining reproductions: `grep -rn "\[7-" tests`.
  - Titles carry the ID: `[7-x]` (section 2 issue) or `[A2]` (acceptance criterion without an issue number).
- **contract-types**: `scripts/contract-types.mjs --variant next-16.1|next-16.3|canary|all --pkg` installs the variant's dependencies + the tarball into `.work/contract@<variant>/` and compiles `tests/contract/types/*.contract.mts` (NodeNext, ESM consumer) and, since P1, `*.contract.cts` (CommonJS consumer through the `require` condition) with the repo's tsc. Not part of the root typecheck.
- **contract-oracle**: `tests/contract/oracle/use-cache.oracle.test.ts`. fast-check programs (set/get/updateTags/time passing) are applied to Next's `createDefaultCacheHandler` and to our handler (mini-redis), and the verdict Next's use-cache wrapper would derive from each get (`miss`/`hit`/`stale`, discarded when the `getExpiration` result >= timestamp) is compared. `Date.now`/`performance.now` are replaced by a virtual clock so both handlers and the mini-redis expiry see the same time. The reference is the root devDependency Next (currently 16.1.6). No Docker, so it is part of `npm test` (vitest project `contract`).
- **chaos scope (P0d)**: C1, C9, C2, C5, C6, C13, C11, C12 from the 6.9 mapping (`tests/chaos/*.test.ts`, vitest project `chaos`, files sequential). Requires `infra:up -- redis84 toxiproxy` and builds of static-site A and B, full-legacy A, full-cc A. C3, C4, C7, C8, C10, C14 are added in the phase that implements the feature (P3, P4, P6).
- **perf metric definition (vs. plan)**: measures **Redis commands per request** instead of "round trips". `INFO commandstats` is server-global and mixes other traffic, so `MONITOR` on a separate connection counts only commands touching this run's namespace. The key shape tells the handler apart (`uc:` = use-cache, `_tags`/`_tagTtls`/`_revalidated` = tag state, the rest = legacy). The use-cache scenario is `/dyn/1` (PPR shell = legacy, dynamic part = use-cache), so it is the sum of both handlers. Gate: commands must not exceed the baseline, memory within +5% on the same Redis minor. Timing via `--time` (autocannon 10 s, 8 connections).

### 6.6 Quality gates and determinism

- Coverage (v8, unit + property + integration + fault merged, `src/**`): lines 90 / branches 85 / functions 90, per file lines >= 80 - **report-only until 2.0.0, blocking from 2.0.0** (blocking since P7: the ci `coverage` job runs `coverage-summary.mjs --check`, rules in `scripts/lib/coverage-rules.mjs`, and is one of the gate's needs - D54).
- `tsc --noEmit` (strict) + contract-types, `publint`, `attw --profile node16` (zero conditional-types errors), `check-pack` whitelist, `check-no-hangul`, `check-commit-messages` (P1), size budgets (ESM gzip per entry, initial measurement +20%), zero eslint errors, mutation >= 70% (blocking from 2.0.0; since P7 `thresholds.break: 70` in `stryker.config.mjs` fails the weekly job - D55).
  - P0a values: attw ignored only the `false-esm` rule until P1 (conditional types) - **removed in P1** (conditional `{types, default}` per export condition, attw `--profile node16` passes without exceptions). size-limit uses `@size-limit/file` to measure the gzip size of the entry file + shared chunks (dist is not minified, so this is the shipped files gzipped, not "min+gz"). 1.0.6: `.` 4.12 kB -> budget 5 kB, `./use-cache` 3.14 kB -> 3.8 kB, `./instrumentation` 1.69 kB -> 2.1 kB, CJS total 7.5 kB -> 9 kB. Only `.size-limit.json`, no `size.mjs`.
  - P1 reset (same +20% rule, 1.1.0 output): `.` 5.47 kB -> 6.6 kB, `./use-cache` 4.5 kB -> 5.4 kB, `./instrumentation` 1.71 kB -> 2.1 kB (unchanged), CJS 8.99 kB -> 10.8 kB.
  - In P0a/P0b CI collected coverage for unit + property only; merging integration and fault came with P0e (reporting).
- Flakiness: no retries (`retry:0`, Playwright `retries:0`). Unstable tests get the `@quarantine` tag (excluded from the gate) + a tracking issue + fixed or deleted within 7 days, nightly `--repeat-each=20`.
  - Implementation (P0e): vitest `itQuarantine("#<issue> until YYYY-MM-DD", name, fn)` (`tests/support/quarantine.ts`) - skipped normally, only those with `repeats: 20` when `NRC_QUARANTINE=only`. Playwright: `@quarantine(#<issue> until YYYY-MM-DD)` in the title, the config uses `grepInvert` normally and `grep` with `NRC_QUARANTINE=only`. `scripts/check-quarantine.mjs` (CI static) fails on a bad issue/deadline format, an expired deadline, or more than 7 days (negative test: injecting an expired deadline or a bad format exits 1). The nightly `quarantine` job repeats x20.
- Reporting: vitest JUnit, JSON, coverage (lcov/html), Playwright html + trace + JUnit, perf JSON -> artifacts, summaries in `$GITHUB_STEP_SUMMARY`. No external services.
  - Implementation (P0e): `scripts/junit-summary.mjs` tabulates JUnit (vitest `reports/junit.xml`, Playwright `reports/e2e-junit.xml`). For coverage the unit (Node 22), integration and fault jobs write blob reports (with coverage) via `NRC_BLOB=<name>`, and the ci `coverage` job merges them with `vitest --merge-reports` and summarizes with `coverage-summary.mjs` (report-only, outside the gate, until P7; since P7 `--check` and part of the gate). perf: `reports/perf.json` + summary, mutation: `scripts/mutation-summary.mjs`.
  - mutation (vs. plan): `@stryker-mutator/vitest-runner` 10.0.0 dry-runs with vitest 5 but reports zero tests per mutant, so everything "survives". The **command runner** runs the Docker-free layers (`vitest.mutation.config.ts`: unit, property, contract, fault/mini-redis) whole per mutant (`--bail 1`). 671 mutants, ~15 min locally (concurrency 4).
- Determinism: package time reads go through an internal `clock.now()` (fake clock in unit/property). Where real time is needed: deadline-bound `waitFor` polling instead of sleeps, TTLs asserted as `PTTL` ranges. A unique namespace `t_<pid>_<seq>` per test; tests that scan globally use a logical DB per worker (`VITEST_POOL_ID % 16`) and FLUSHDB only that DB. Dynamic ports. Content from a seeded generator.

### 6.7 Local DX

Requirements: Node 22 LTS (`.nvmrc`), npm 10+, Docker Desktop (WSL2, compose v2), 8 GB free memory, `npx playwright install chromium` (P0c~).

| Script | Content |
|---|---|
| `test` | unit + property + contract-oracle (no Docker; oracle since P0c) |
| `test:unit` / `test:prop` / `test:int` / `test:fault` / `test:contract` | per layer. `test:fault` = fault + fault-docker, `test:fault:nodocker` = mini-redis part only |
| `check-no-hangul` / `check-pack` | individual gates |
| `test:e2e` / `test:chaos` / `test:perf` / `test:mutation` | Playwright (needs builds) / vitest chaos (needs builds + infra) / `perf.mjs --check` / Stryker |
| `test:contract` = `test:contract:oracle` (vitest contract) + `test:contract:types` (`contract-types.mjs --variant all`) | P0c..P0d |
| `test:all` | infra:up -> every layer -> infra:down |
| `infra:up` / `infra:down` / `infra:logs` / `infra:ps` / `infra:cli` | compose management |
| `pack:local` / `apps:prepare` / `fleet` / `origin` | build the tarball / assemble and build apps / manual fleet (LB 3000, origin 4010 by default) / origin alone |
| `quality` | publint + attw + size-limit + check-pack + check-no-hangul (runs all, fails if any failed) |

One local e2e round: `npm run infra:up -- redis84 toxiproxy` -> `node scripts/prepare-app.mjs all --build A` (`--pkg npm:1.0.6` for the 1.0.6 baseline) -> `npm run test:e2e`. For chaos additionally `node scripts/prepare-app.mjs static-site --build A,B`, then `npm run test:chaos`.

### 6.8 CI

`ci.yml` (pull_request, push, workflow_call `level: pr|full`):

```
setup (matrix, pack -> tgz artifact)                    [P0c~]
 |- static: check-no-hangul, check-commit-messages, lint, typecheck, build, quality
 |- unit: Node [22,24]   (Node 20 reached EOL on 2026-04-30 and vitest 5 / size-limit 14 require ^22.12 -> excluded)
 |- unit-windows: windows-latest Node 22 (Docker-free layers: unit, property, fault (mini-redis), check-pack)
 |- integration: Node 22 x Redis [7.2, 8.4] (+ Redis 8.4 x @redis/client 6)   [P0b~, P1]
 |- fault: Node 22 (infra:up redis84+toxiproxy -> mini-redis + toxiproxy -> infra:down)   [P0b~]
 |- contract: Next [16.1, 16.3] (+full: canary)       [P0c~]
 |- e2e: pr = 16.3 x 8.4 x 3 apps / full = [16.1,16.3] x [7.2,8.4] x 3 apps (+canary)   [P0c~]
 `- gate: every required job succeeded (the only required check for branch protection)
```

- `nightly.yml` (cron): ci full + chaos + perf + quarantine repeats + e2e on Node 24, opens an issue on failure. weekly: mutation + all of canary.
- `release.yml`: `jobs.gate: uses: ./.github/workflows/ci.yml with level: full` + the required chaos subset -> `release` (needs all) publishes with changesets + OIDC. A commit that fails the gate cannot publish.
- Caching: setup-node npm cache (`package-lock.json`, `test-apps/_variants/*/package-lock.json`), Next build cache (`.work/*/.next/cache`), Playwright browsers. Planned: build only `app x Next` (6) and let Redis cells reuse artifacts (see D7 for what was done).
- Budgets: PR <= 15 min, full/nightly <= 60 min, weekly mutation <= 90 min (P7: 71 min for 2030 mutants on a GitHub runner - more tests per mutant eat into the margin; `fsModuleCache` saved only ~7 % per run locally and was not adopted).
- Security: actions pinned to SHAs, default `permissions: contents: read`, only the release job has `id-token: write`, `contents` and `pull-requests: write`.
- **Trusted publishing (OIDC)**: (1) (user, npmjs.com) package Settings -> Trusted Publisher -> GitHub Actions, owner `mirunamu00`, repo `next-redis-cache`, workflow `release.yml` (environment optional) (2) workflow on Node 24 or npm >= 11.5.1, `id-token: write`, no `NODE_AUTH_TOKEN` (3) verified by actually publishing 1.1.0 (4) (user) "Require 2FA and disallow tokens", revoke the `NPM_TOKEN` secret and token. Risk (guess): whether changesets/action's `.npmrc` handling and the empty token from `setup-node registry-url` conflict with OIDC - try the first publish as a prerelease.
  - **P1 findings (final)** - full commands in section 11.
    - (1) also works from the CLI: `npm trust github` (npm **>= 11.15.0**; 12.x requires Node ^22.22.2, so on the local Node 22.21 use `npx npm@11.20.0`). The account needs 2FA; **granular tokens that bypass 2FA and username/password auth are rejected** (interactive login + OTP). One configuration per package (to change it: `npm trust list` -> `revoke` -> create again). `--dry-run` output checked: `{package, file: release.yml, repository: mirunamu00/next-redis-cache, permissions: [createPackage]}`.
    - The risk in (2) is resolved: changesets/action **v1.7.0+** writes no `.npmrc` and takes the trusted-publishing path when the `NPM_TOKEN` env is unset and the OIDC env (`ACTIONS_ID_TOKEN_REQUEST_*`) is present (checked in the v1.9.0 source). setup-node gets no `registry-url` (it would write an `.npmrc` with a `NODE_AUTH_TOKEN` placeholder). In CI `changeset publish` skips the OTP and `npm profile` checks and runs `npm publish <dir> --json --access public --tag latest`. changesets/action **v2 requires Changesets CLI v3**, so the workflow is pinned to v1.9.0.
    - Provenance: generated automatically with trusted publishing, made explicit with `NPM_CONFIG_PROVENANCE=true`. P1 added `package.json` `repository.url`, which provenance verification requires (E422 without it).
    - (3) 1.1.0 is not published yet (this branch is not master). The `NPM_TOKEN` secret is probably expired and cannot be updated from here (no gh, no GitHub token) -> fallback in section 11.
- Prereleases: `changeset pre enter next` on the `next` branch -> `2.0.0-next.N` (dist-tag `next`), `pre exit` before stable.
- **P0c..P1 implementation (final, including differences from the plan)**
  - Triggers: `push` also on `feat/**` (validate feature branches without PRs; no gh CLI). `pull_request`, `master` and `next` unchanged.
  - ci.yml jobs: static (+check-quarantine, +check-commit-messages since P1) · unit [22,24] · unit-windows · integration [7.2, 8.4] (+ client 6) · fault · setup (build + pack -> `package-tarball` artifact) · contract [16.1, 16.3 (+canary on full, continue-on-error)] · e2e [app x 16.3 x 8.4 / full: app x [16.1,16.3] x [7.2,8.4]] · perf (deterministic gate, `--time` on full) · coverage (merged, outside the gate until P7, a gate need since P7 - D54) · gate.
  - Each e2e cell builds its own app (plan: build `app x Next` 6 times and reuse artifacts per Redis cell). A build takes 30..40 s, cheaper than moving hundreds of MB of standalone output (static-site 145 MB) through artifacts.
  - No Playwright browser install (server actions are verified by form submission). Add `npx playwright install --with-deps chromium` to a job once a test needs a browser.
  - `chaos.yml`: reusable workflow (`workflow_call`, `workflow_dispatch`, inputs `files` and `variant`). Builds the apps (static-site A and B, full-legacy A, full-cc A), then `vitest --project chaos`.
  - `nightly.yml`: daily 03:17 KST - ci level=full + all chaos + quarantine x20 + e2e on Node 24 (3 apps). Weekly Monday 04:41 KST - + mutation + canary e2e (single job, test step `continue-on-error`, the report reads the outcome). A failed scheduled run (or a failed canary) makes `scripts/nightly-issue.mjs` open or comment on an issue labelled `nightly-failure`. **Schedules only run on the default branch**, so a `feat/**` push that changes nightly.yml or chaos.yml runs everything once, weekly jobs included (no issue is filed).
  - `release.yml`: `gate` (ci.yml level=full) + `chaos` (required subset: `startup.test.ts` C1, C9 and `rolling.test.ts` C11, C12) -> `release` with `needs: [gate, chaos]`. The planned C3 (unresponsive) and C7 (eviction) join the subset in the phase that adds them (P3, P6). The publishing setup (NPM_TOKEN, tag-referenced actions, Node 20) was replaced in P1 by OIDC, SHA pinning and Node 24 (release job: checkout v7.0.1, setup-node v7.0.0, changesets/action v1.9.0 pinned to SHAs, Node 24 + `npm@11.20.0`, no token, `id-token: write` only in the release job, skipped on forks).
  - P1: an `@redis/client 6` cell in the ci.yml integration matrix (Redis 8.4, `npm i --no-save @redis/client@6`, then typecheck + the whole integration layer). Cell name `integration (Redis x, @redis/client lock|6)`, the client is part of the blob and artifact names (no collisions in the merged coverage). fault and oracle are not run in the 6 cell - mini-redis speaks RESP2 only and 6 opens with `HELLO 3`.
  - P1: `scripts/check-commit-messages.mjs` in the static job (checkout with `fetch-depth: 0`): every commit in `origin/master..HEAD` (falling back to the pushed range, then HEAD) must be free of Hangul.
  - Static workflow check: `docker run --rm -v <repo>:/repo -w /repo rhysd/actionlint` (local, nothing to install). Only one info finding (quoting in the gate's `node -e`). In Git Bash on Windows prefix `MSYS_NO_PATHCONV=1` (otherwise `-w /repo` is rewritten to a Windows path).
  - 2.0 (P3..P6): the contract job also runs the runtime fallback contract and the README type check per variant (same step, `contract-types.mjs`); chaos.yml starts `prodlike` too (C7, C8); the release chaos subset is startup + rolling + degraded + pressure (D39); release.yml also runs on `next` for the prereleases (section 12.2).

### 6.9 Regression mapping (fails on 1.0.6 first)

| ID | Layer | App / tool | Scenario |
|---|---|---|---|
| 7-1 | integration + oracle + e2e | full-cc, full-legacy | set -> get hit after `updateTags([t],{expire:31536000})` / oracle mismatch / after an action `revalidateTag(t,'max')` the 3rd request hits, origin +1 (A7), same for legacy `/pinned` |
| 7-2 | fault + chaos C1, C9 | static-site | `get()` null within 1.5 s on a closed port / waiting connect, no reject when the hook throws / fleet starts without Redis, sitemap 200 within 2 s (A2) |
| 7-3 | fault (mini-redis) + chaos C2, C5 | full-cc | 100 gets after a `reconnectStrategy:false` disconnect -> zero unhandled / 100 gets while reconnecting -> zero queued GETs after recovery (A4) |
| 7-4 | integration + e2e | static-site | after prewarm `segmentData` keys = meta `segmentPaths`, `/index` and og APP_ROUTE keys exist, not-found status kept / segment prefetch 200 (A6) |
| 7-5 | integration + perf | static-site | 1000 x `EX 1` -> DBSIZE back to baseline after 2 s / key bound after 10 deployments (A5) |
| 7-6 | e2e + chaos C6, C13 | full-legacy `/pinned`, `/race` | right after revalidatePath 200 + old body -> new body, 200 after FLUSHALL, no old data coming back after an invalidation during a render (I5) |
| 7-7 | unit + fault | - | hang during set -> one `logger.warn`, repeated failures only on transitions |
| 7-8 | contract-types | - | peer range + 16.x contract only (Next 15 excluded) |
| 7-9 | integration + chaos C11, C12 | static-site A/B | 10k keys, UNLINK batches <= 500, recently used old builds held during rolling + TTL cap, runs after ready when not connected yet, port of docs `build-keys.test.mjs` |
| 7-10 | unit | - | `vi.getTimerCount()===0` after a successful command |
| 7-11 | unit + integration | full-legacy route handler | APP_ROUTE revalidate=5 -> PTTL ~7.5 s, static -> staticSeconds, no immediate expiry when re-seeding an old lastModified |
| 7-12 | integration + property | - | NX set leaves existing metadata unchanged, get waits for the second of overlapping sets of one key |
| 7-13 | static | - | extract README code blocks -> compile with contract-types |

Checks migrated from docs: `prod-cache.spec.ts` (200 without Redis) -> static-site e2e + C1 / `resilient-cache-handler.test.mjs` -> fault + C3, C6 / `redis-connect.test.mjs` -> fault / `build-keys.test.mjs` -> integration + C11, C12 / `no-redis.test.mjs` -> unit + static-site e2e.

**P0d reproduction status (1.0.6, all registered as expected failures)** - evidence = the actual failure messages with `NRC_REPRO=show`.

| ID | Reproductions (files) | 1.0.6 failure |
|---|---|---|
| 7-1 | integration `repro.test.ts` 3, oracle (durations), e2e full-cc and full-legacy 1 each | get of an entry written after `updateTags(t,{expire:1y})` -> `undefined`, `getExpiration` = now + 1 year, legacy entry `null` too / oracle counterexample: reference `k0=hit:v1`, ours `k0=miss` / full-cc: 5 origin calls after 'max' (expected 1) / legacy pinned keeps 404 after 'max' |
| 7-2 | fault `repro-connection.test.ts` 3, chaos C1 2, C9 1 | get unsettled within 1.5 s on a closed port (`settled:false`), a throwing hook propagates as a reject, `cleanupOldBuildKeys` unsettled within 3 s / an instance with prewarm on is not ready within 10 s, first page times out after 5 s (no Redis, wrong password) |
| 7-3 | fault 2, chaos C2 2, C5 1 | 100 gets on a closed client -> 100 unhandledRejections ("The client is closed"), 100 gets while reconnecting -> 100 GETs replayed after recovery / 3 s outage under traffic -> 171 (C2) and 165 (C5) unhandledRejections, 3..22 queued GETs after recovery |
| 7-4 | integration 4, e2e static-site 1 | segment keys `['_full','_tree','about/__PAGE__']` (expected leading `/`), no `/index`, no `/icon` (APP_ROUTE), `/_not-found` not prewarmed / `/_tree` prefetch of the prewarmed `/about` 404 |
| 7-5 | integration 2 | `_tags` HLEN 50 after expiry (expected 0), one broken field aborts the whole revalidateTag -> the entry keeps being served |
| 7-6 | integration 2, e2e full-legacy 1, chaos C6, C13 | get `null` after `revalidateTag(t,{expire})`, a render from before an explicit-tag invalidation comes back as fresh / only 404 observed after revalidatePath / docs 404 after the namespace is deleted / `HIT` + old version after an invalidation during a slow render |
| 7-7 | fault 1 | zero console.warn/error for a failed set while Redis hangs |
| 7-8 | unit 1, contract-types `@ts-expect-error` 2 | lowest peer major 15, the legacy class cannot be constructed with Next's `CacheHandlerContext` (index signature of its own context type) |
| 7-9 | integration 2, chaos C11, C12 | 10k keys deleted with one DEL (expected >= 20 calls), a just-read old build key deleted / old instances 404 docs during rolling and rollback |
| 7-10 | unit 1 | one timer left after success |
| 7-11 | unit 3, integration 1 | APP_ROUTE revalidate 5 -> EX 47,304,000 (1.5 years), static 1.5 years > 30 days, re-seeding a lastModified from two days ago stores nothing / PTTL 47,304,000,000 ms |
| 7-12 | integration 3 | tags overwritten with `['b']` although NX skipped, a value written by another pod deleted as orphaned, get returns `first` with overlapping sets |
| 7-13 | unit 4 | default use-cache key `uc:app:b1:...` (outside keyPrefix), README `cacheLife("hours")` comment stale 3600 (actually 300), no Security section, "every Redis call has a timeout" claim |
| A2 | e2e static-site 1 | `dynamicParams=false` docs 404 on an empty Redis (no prewarm) |

**P1 (1.1.0) conversion status** - each fixing commit removed its markers (`itRepro` -> `it`, `repro()` deleted). Reproductions written in P1 (7-1 heal, 7-4 APP_ROUTE meta and postponed, 7-7 transitions, 7-9 overlapping patterns) were first confirmed to fail on 1.0.6 and committed on their own (39182bd).

| ID | Converted (now regular tests) | Remaining reproductions (phase) |
|---|---|---|
| 7-1 | integration 4 x 2 versions (entry written after the update is readable, getExpiration <= now, legacy via the shared hash, heal of a 1.0.x future time), e2e full-cc: one regeneration after 'max' | oracle (durations): Next serves an older entry stale once (1.x misses), and Next's default `getExpiration` returns the future `expired`, discarding soft-tagged entries (1.x hits) - P2 `_tagstate` |
| 7-2 | fault 1 (`cleanupOldBuildKeys` gives up within 3 s - fixed by 7-9's connect timeout) | fault 2 (endless connect wait with the 1.0.x README wiring, a throwing hook propagates), chaos C1 2, C9 1 - P2 (`connectRedis`, isolating hook errors). The 1.1.0 README wiring (1 s bounded race) is verified by a fault test |
| 7-3 | fault 2, chaos C2 2, C5 1 | - |
| 7-4 | integration 6 x 2 versions, e2e static-site segment prefetch 200 (A6, `/` added) | - (A2, 404 on an empty Redis, is P3) |
| 7-5 | - | integration 2 (P2) |
| 7-6 | - | integration 2, e2e full-legacy 2 (the pinned 'max' 404 was moved from 7-1 to 7-6 - with the future time gone, the remaining cause is the legacy deletion), chaos C6, C13 (P2) |
| 7-7 | fault 1, unit 2 (transition-based: one warn for 20 failures, one info on recovery) + unit tests of the reporter and of what the handlers report | - |
| 7-8 | - | unit 1, contract-types 2 (P2: peer `next ^16.1`) |
| 7-9 | integration 2 x 2 versions (batches of 500, overlapping patterns counted once) | integration 1 (keep a recently used old build), chaos C11, C12 - P4 registry cleanup |
| 7-10 | unit 1 | - |
| 7-11 | - | unit 3, integration 1 (P2 TTL policy) |
| 7-12 | - | integration 3 (P2) |
| 7-13 | unit 3 (README cacheLife, Security, timeout claim) | unit 1 (default use-cache key outside keyPrefix - a key format change, P2) |

Local results (end of P1, Windows + Docker Desktop, Next 16.3.6, tarball install): typecheck, lint, build and quality pass; `npm test` 56 passed + 6 expected failures; fault (+docker) 28 + 2; integration 48 + 18 (Redis 7.2 and 8.4); e2e 3 apps 18 passed (3 expected failures: A2, two 7-6); chaos 6 passed + 7 expected failures (C1 x2, C9, C6, C13, C11, C12); perf baseline 1.1.0. With `@redis/client 6.2.1`: typecheck + all 46 integration tests pass.

Controls that pass on 1.0.6 (= not bugs) are kept as well: immediate expiry `updateTags(tags)` agrees with the oracle (at least 10 hits and 10 misses observed), the legacy handler checks readiness first and queues nothing while reconnecting, the updateTag server action is applied immediately, C2 and C5 keep I1 (all 200) and I4 (hits resume within 10 s).

**2.0 conversion status (P2..P6, `feat/v2`)** - no reproduction marker is left (`grep -rn "itRepro(|repro(\"|ts-expect-error [7-" tests` finds only the helper definitions). Each fixing commit removed its markers; tests of 1.x-only APIs were restated against their 2.x replacement in the same commit.

| ID | Converted in 2.0 | Commit (phase) |
|---|---|---|
| 7-1 | oracle with durations: the fixed program from master (reference `k0=stale:v1`, 1.x `k0=miss`) + 60 random programs that must produce >3 stale answers; integration: older entry served stale once, shared tag state both ways | 3798f43 (P2) |
| 7-2 | fault x2 (connectRedis wiring settles as a miss within 1.5 s; a throwing client function is a miss), chaos C1 x2, C9 | 3798f43 (P2), 175ed44 (P3) |
| 7-5 | integration x2 (nothing but `_tagstate` outlives the entries; a corrupted tag field does not stop other invalidations) + "every entry key has a TTL" | 3798f43 (P2) |
| 7-6 | integration x2 (SWR after `revalidateTag(t, {expire})`; render across an invalidation is not fresh), e2e full-legacy x2, chaos C6, C13 | 3798f43 (P2), 175ed44 (P3) |
| 7-8 | unit (peer `^16.1.0`), contract-types x2 (`@ts-expect-error` removed) | 3798f43 (P2) |
| 7-9 | integration "keeps an old build still being read" (restated against `cleanupOldBuilds`), chaos C11/C12 (I1 by the fallback in P3; registry + TTL caps in P4) | 175ed44 (P3), 174b511 (P4) |
| 7-11 | unit x3, integration (APP_ROUTE PTTL ~7.5 s) | 3798f43 (P2) |
| 7-12 | integration x3 (NX leaves the entry unchanged, get never deletes, overlapping sets) | 3798f43 (P2) |
| 7-13 | unit (use-cache key inside the namespace); README code blocks type-checked by contract-types (new) | 3798f43 (P2), 71971bb |
| A2 | e2e static-site (empty Redis, no prewarm), unit build-output fallback | 175ed44 (P3) |

Acceptance criteria evidence (local, Windows + Docker Desktop, Next 16.3.6 unless noted): A1 all 7-x above; A2 e2e + C1 (first page < 2 s without Redis); A3 fault (first call ~300 ms with readMs 300, then < 50 ms each) + chaos C3 (median +< 50 ms with the circuit open); A4 fault (no queued/replayed command for 50 x get/set/updateTags while reconnecting, zero unhandled rejections) + chaos C2, C5; A5 integration (10 simulated deployments: <= 2 builds of keys + 2 shared keys, only `_tagstate`/`_builds` without TTL); A6 e2e (prewarmed and re-seeded pages answer `/_tree` prefetches with 200); A7 e2e full-cc (one stale answer + one regeneration after 'max', `updateTag` read-your-own-writes on 16.1 and 16.3) and full-legacy; A8 e2e full-cc (invalidation on instance a, instance b reads new data) + integration; A9 perf (one build 17,424,668 B vs 149,519,924 B in 1.1.0 = -88.3%); A10 is P5 (docs).

---

## 7. Roadmap

| Phase | Work | Done when | Depends on | Size |
|---|---|---|---|---|
| **P0a skeleton, CI** | layout, tsconfig split, vitest projects, eslint, `.gitattributes`, `.nvmrc`, LICENSE, `check-pack`, `quality` (publint/attw/size), `ci.yml` (static/unit/unit-windows/gate) | local typecheck, build, lint, test, quality pass. Publish whitelist gate works. Existing src behavior unchanged | - | S-M |
| **P0b infrastructure** | compose (redis72/redis84/prodlike/toxiproxy/replica), testcontainers helper, mini-redis TS port + own tests, toxiproxy client, `infra:*`, namespace/DB isolation, ci.yml integration/fault jobs | `infra:up` works on Windows Docker Desktop and Linux CI, Redis 7.2/8.4 integration smoke, 4 toxics controlled from tests | P0a | M |
| **P0c test apps, harness** | 3 apps, `_variants` 16.1/16.3/canary, `pack`, `prepare-app` (tgz, `npm:1.0.6`, `--hot-dist`), origin server, fleet (LB, rolling), test hooks, `NRC_API` v1/v2 adapters, contract and e2e jobs | every app builds standalone on 16.1 and 16.3, a 2-instance fleet runs with **1.0.6 (v1 API)**, `npm ls` single Next, cacheComponents constraint confirmed | P0b | L |
| **P0d reproductions, baselines** | `it.fails`, e2e and chaos failures from the 6.9 mapping, oracle diff, perf baseline (1.0.6 round trips, memory) committed | every item reproduced on 1.0.6, baseline JSON committed, ci e2e (pr) works | P0c | M |
| **P0e nightly, reporting** | `nightly.yml`, release gate, artifact reports, flakiness policy, Stryker | nightly completes once, release cannot publish without the gate | P0d | S |
| **P1 1.1.0 hotfix** | section 4 list + LICENSE, exports types, SHA-pinned actions, OIDC | reproductions converted, static-site e2e segment prefetch 200, OIDC + provenance publish | P0e | M - **done**, 1.1.0 released from master |
| **P2 v2 core** | factory API, key schema and envelope, `_tagstate`, Next 16 semantics (legacy and use-cache SWR, `getExpiration=Infinity`), run pipeline (circuit, timeouts), logger and onEvent, `connectRedis`, build-phase no-op, TTL policy -> `2.0.0-next.0` | A1 (7-1, 2, 3, 5, 6, 7, 10, 11, 12), A4, A7, A8 - judged by oracle, fault, full-cc e2e | P0 | L - **done** (3798f43; A7 on 16.1 completed by D43 in 57623bd) |
| **P3 fallback, prewarm** | FileSystemCache fallback, re-seed, new prewarm, Next matrix contract -> `next.1` | A2, A3, A6 (static-site e2e, C1, C3, C6), 16.1 and 16.3 pass | P2 | M - **done** (175ed44) |
| **P4 maintenance** | `cleanupOldBuilds`, `whenReady`, `startCacheMaintenance`, v1 layout compatibility, reserved `_*`, deprecated `cleanupOldBuildKeys` -> `next.2` | A5 (C11, C12, integration) | P2 | S-M - **done** (174b511; + chaos C8) |
| P5 docs integration (main session) | switch docs configuration, delete the wrapper and `tests/unit/*`, docs keeps `test:e2e:prod` + production smoke after rollout (sitemap 200, logs, Redis keys and memory) | A10, 24 h in production without incidents, one rollback rehearsal | P3, P4, P1 | S - **in progress** (main session): docs master c943f3c runs `2.0.0-next.0` (exact pin) in production, the production check passed (section 2.2; its two findings 7-14 and 7-15 are fixed for 2.0.0); 24 h without incidents and the rollback rehearsal are pending |
| **P6 optimization** | compression, `MEMORY USAGE` measurement, `tagStateCacheMs`, pipelining, optional HEXPIRE (>= 7.4) -> `next.3` | A9, <= 2 round trips per hit | P2 | S-M - **done** (57623bd; + chaos C7, C14) |
| P7 2.0.0 (main session) | README rewrite, MIGRATION.md, pre exit, docs `^2.0.0`, coverage and mutation gates become blocking | every acceptance criterion met, stable release | P5, P6 | S - README, MIGRATION.md and the major changeset are ready (71971bb); on `next` (section 12.4): coverage and mutation gates blocking (D54, D55), more Docker-free tests, 7-14 and 7-15 fixed, pre mode exited (D56). Left for the main session: P5 done, merge `next` into master, release PR -> 2.0.0, docs `^2.0.0` |

The version tags `next.0..3` per phase were not cut: the phases were built in one run on `feat/v2` without publishing (Q18); the first prerelease is `2.0.0-next.0` with everything (section 12).

Cluster verification and rollback (P5): replicas is 1, so there is no real canary. (1) Run the new image locally against production Redis (8.4, auth) through `kubectl -n mirunamu port-forward svc/redis-master 6379`, isolated in the namespace `docs-canary` (password read from the Secrets repo, never committed) (2) after deploying, smoke logs, Redis memory, key count, sitemap (3) roll back by reverting the helm-chart auto-tag commit -> ArgoCD. Old build keys stay with keepPrevious=1 + a 1-day TTL cap, so a rollback within a day is warm.

---

## 8. Decisions (approved by the user on 2026-09-29)

| # | Decision |
|---|---|
| Q1 | Ship the 1.1.0 hotfix first, then 2.0 |
| Q2 | Drop Next 15 support, peer `next ^16.1` |
| Q3 | Disk (build output) fallback on by default. Next internal paths guarded + matrix contract tests |
| Q4 | Tag state is namespace-global |
| Q5 | Lazy invalidation only (no reverse index, no eagerDelete option) |
| Q6 | Compression starts at none, decided again after P6 measurements |
| Q7 | Default timeouts read 1000 ms / write 2000 ms |
| Q8 | Minimum supported Redis 6.2, HEXPIRE optional on 7.4+ |
| Q9 | Prewarm off by default in the package and in docs - confirmed after static-site perf numbers |
| Q10 | No TTL on `_tagstate` (bounded by the tag count, not evicted under volatile-lru = intended) |
| Q11 | Prereleases in pre mode on the `next` branch, master can still publish 1.x hotfixes |
| Q12 | Metrics only through the `onEvent` hook |
| Q13 | Coverage and mutation gates block from 2.0.0, report-only before |
| Q14 | perf on GitHub-hosted runners, only deterministic metrics are hard gates |
| Q15 | canary allowed to fail in nightly/weekly + issue notification |
| Q16 | No external coverage service (artifacts + step summary) |
| Q17 | Windows CI runs Docker-free layers only. Docker layers: local Docker Desktop by hand + Linux CI |
| Q18 | (2026-09-29, user) CI without PRs: `feat/**` in ci.yml `push.branches`. Only feature-branch pushes (no master/next pushes, no force-push, no npm publish) |
| Q19 | (2026-09-29, user) Next variants pinned to the latest 16.1.x and 16.3.x patches + matching react. canary unpinned, nightly only, allowed to fail |
| Q20 | (2026-09-29, user) Everything in the repository is English, including Markdown and commit messages. Enforced by `check-no-hangul` (all files) and `check-commit-messages` (`origin/master..HEAD`). The existing Korean commit messages on `feat/test-infra` were rewritten to English and force-pushed at the user's request (trees byte-identical) |

### 8.1 Decisions made during execution (within the scope the user delegated)

| # | Decision | Reason |
|---|---|---|
| D1 | Test apps in JS (.jsx/.mjs) | no typescript in the variants, lighter builds. Types are checked by contract-types |
| D2 | Test hook path `/api/nrc-test/*` | `__test` is an App Router private folder |
| D3 | v1 adapter = the 1.0.x README Quick Start wiring as-is | reproductions must see the real user experience |
| D4 | Reproduction convention: `itRepro` / `repro()` / `@ts-expect-error [7-x]` + `NRC_REPRO=show` | only green when the fixing commit removes the marker; evidence can be printed |
| D5 | Deterministic perf metric = commands per request counted with MONITOR | `INFO commandstats` is server-global and mixed |
| D6 | mutation = Stryker command runner | vitest-runner 10.0.0 + vitest 5 reports zero tests per mutant |
| D7 | Each e2e cell builds its app, no browser install | a 30..40 s build < moving standalone artifacts; server actions are verified by form submission |
| D8 | A `feat/**` push that changes nightly.yml or chaos.yml runs nightly once (weekly jobs included) | schedules only run on the default branch, so there is no other pre-merge check |
| D9 | Required release chaos subset = C1, C9, C11, C12 (implemented so far) | C3 and C7 join in their phases |
| D10 | static-site body 100..250 KB text (HTML 200..500 KB) | 1 MB HTML is too heavy for local iteration |
| D11 | (P1) 7-1: `updateTags(tags, durations)` also records `now` (not SWR). A time more than 60 s in the future (left by 1.0.x) is treated as `now` when read and rewritten with a best-effort HSET (not awaited, failures ignored) | With one value per tag (schema unchanged) stale and expired cannot be told apart - one miss then normal is better than a year of misses and closest to Next's default (serve stale once). Without healing, polluted tags would stay up to a year after upgrading. 60 s = clock skew allowance between instances. A concurrent updateTags between the read and the heal can be moved back by a few ms (documented) |
| D12 | (P1) `cleanupOldBuildKeys` never rejects because of Redis: `timeoutMs` (default 5000, connect and commands), `reconnectStrategy:false`, on failure warn and resolve with the number deleted so far | The README awaits it in instrumentation - a reject fails startup; 1.0.6 waited forever |
| D13 | (P1) Error logging = one `ErrorReporter` per handler: warn on the transition, a summary at most once a minute, info once on recovery. Keys cut at 120 chars. Only Redis round trips count (a failed render is not reported; calls without tags are not a recovery) | Logging every request floods logs during an outage; the debug gate was silent (7-7). logger option and onEvent come in 2.0 (5.3) |
| D14 | (P1) peer `@redis/client` `^5.0.0 \|\| ^6.0.0`, a 6 cell in CI (integration + typecheck) | 6.2.1 verified locally (RESP3 by default). `>=5` admitted an unverified 7.x |
| D15 | (P1) `engines.node >=18.18.0` | the 1.x peer admits Next 15 (>= 18.18). `>=20.9` in 2.0 |
| D16 | (P1) release: changesets/action v1.9.0 pinned to a SHA, `npm@11.20.0` installed at a fixed version, no setup-node `registry-url`, `NPM_CONFIG_PROVENANCE=true` | v2 needs Changesets v3. Pinning npm has the same supply-chain reason as pinning actions |
| D17 | (P1) The README Quick Start uses a 1 s bounded connect race, but the test apps' v1 adapter keeps the 1.0.x README wiring | keeps D3 (reproduce the existing user experience) - the 7-2 reproductions (C1, C9) stay meaningful. The new wiring is verified by a fault test |
| D18 | (P1) The e2e full-legacy pinned 'max' reproduction moved from 7-1 to 7-6; oracle (durations) stays a 7-1 reproduction (P2) | after 1.1.0 the remaining causes are the legacy deletion and the SWR / Next getExpiration semantics respectively |
| D19 | (P1) perf `--as <version>`, baseline `1.1.0.json` (with `packageVersionField: 1.0.6`) | before `changeset version` the installed version is still 1.0.6 - writing as-is would overwrite 1.0.6.json |
| D20 | (P1) Commit-message check over `origin/master..HEAD` | the branch history was rewritten to English, so the whole range can be enforced |
| D21 | (P2) `_tagstate` holds two fields per tag (`s:<tag>`, `x:<tag>`) instead of one `"stale,expired"` value | every update stays one idempotent HSET that leaves the other field alone - exactly Next's partial updates, no read-modify-write; the HMGET reads 2 fields per tag |
| D22 | (P2) A legacy entry's lastModified is the time of the miss / stale / time-stale answer that triggered its render (5 min window, earliest pending wins), not the time of `set` | fixes C13 / 7-6 (an invalidation during a slow render left the old result fresh) for one and several instances; Next's own file-system cache has the same race. Worst case: one extra regeneration |
| D23 | (P2) Implicit tags in use-cache `get`: the wrapper's getExpiration rule (`timestamp <= max(expired)`), entry tags: `areTagsExpired`/`areTagsStale`; `getExpiration` returns Infinity | identical outcomes to Next's default handler + wrapper (oracle, with and without durations), one round trip for the implicit tags |
| D24 | (P2) Own timeout race for every command, the client's `timeout` option is not used | @redis/client's option only covers the time before the command is written |
| D25 | (P2) Circuit breaker per client object, opened only by timeouts | handlers sharing a client share its health; WRONGTYPE/OOM are answers, not unresponsiveness |
| D26 | (P2) A client function is awaited at most 3 s per call, the first client is kept, `null` is asked again (logged once as info) | a slow or never-settling function must not stall requests (7-2); `() => connectRedis(url)` resolves within waitMs |
| D27 | (P2) `LegacyCacheHandler` (named/default export) and `registerInitialCache` removed, not deprecated | the factory replaces the static class; registerInitialCache called `set` of a 1.x class - `prewarmFromBuildOutput` replaces it (P3) |
| D28 | (P2) Envelope: strings >= 1 KiB as blobs, compression only for payloads >= 1 KiB, brotli quality 4 | no JSON escaping of large HTML; quality 11 is far too slow per write, 4 is close to gzip speed with better ratios |
| D29 | (P3) Test apps default to `NRC_API=v2` (the 2.x README wiring); `v1` only with a 1.x package | 2.x no longer exports the v1 API; baselines against npm 1.x still work |
| D30 | (P3) The fleet drains in-flight requests before stopping an instance | C11/C12 reported 502s for requests killed mid-flight once the 404s were gone - a harness artifact, Kubernetes removes the endpoint first |
| D31 | (P3) C11/C12 converted in P3 (the build-output fallback guarantees I1), cleanup assertions added in P4 | they assert I1 only; the registry/TTL behavior is checked separately |
| D32 | (P3) e2e `repro.spec.ts` renamed `regressions.spec.ts` | nothing in them is an expected failure any more |
| D33 | (P3) Runtime contract per Next variant: `tests/contract/runtime/fallback.contract.mjs` run by contract-types inside the variant install | guards the internal `file-system-cache.js` path on every PR for 16.1 and 16.3 (the e2e matrix covers 16.1 only nightly) |
| D34 | (P3) C3's A3 check compares the median latency with the circuit open to the median with a healthy Redis (< 50 ms) | single requests on a shared Windows machine vary by more than 50 ms |
| D35 | (P3) C3 simulates an unresponsive Redis with a 30 s downstream latency toxic, not a `timeout` toxic | the timeout toxic drops bytes, which desynchronizes RESP pipelining after recovery (replies matched to the wrong commands) - unlike a real stalled Redis |
| D36 | (P2) use-cache `set` consumes the entry stream without `tee` | as planned; the e2e and oracle layers pass on 16.1 and 16.3 |
| D37 | (P3) Build-output fallback while Redis is unusable: state "unknown", served as it is, no re-seed | the tag state cannot be read; serving the build is the documented degraded behavior |
| D38 | (P3) Prewarm treats a page as partially prerendered when its meta has `postponed` (no `.rsc` read) | same rule as 1.1.0's verified prewarm; Next's request path decides per route |
| D39 | (P3) Release chaos subset: startup, rolling, degraded (C3, C4, C10); P6 adds pressure (C7, C14) | D9 planned C3 and C7 |
| D40 | (P4) 1.x tag hash names (`__sharedTags__`, `__sharedTagsTtl__`, `__revalidated_tags__`, `_tags`, `_tagTtls`, `_revalidated`) are not reserved owners for cleanup | 2.x never reads them; without the exception a 1.x layout without a build segment (`app:_tags`) would stay forever |
| D41 | (P4) chaos.yml starts the prodlike profile too; new C8 (AOF restart) | C7 and C8 need a production-like Redis |
| D42 | (P6) Compression default `"brotli"` (Q6 decided): one static-site build 17.4 MB (brotli) / 20.5 MB (gzip) / 122.5 MB (none) / 149.5 MB (1.1.0); p50/p99 unchanged within noise for all three | A9 (-88%) at no measurable latency cost; every setting reads every other |
| D43 | (P6) `onTagExpired` gains `"auto"` (default): an expired page/route is a miss unless the path is a prerendered path of a `dynamicParams = false` route (prerender-manifest), then `lastModified -1` | the nightly e2e found that Next 16.1 serves a `-1` entry once (SWR) while 16.3 regenerates before answering; `updateTag` must be read-your-own-writes (A7) on both, and only fallback:false paths 404 on a miss. Matches Next's own FileSystemCache (null for expired tags) |
| D44 | (P6) `tagStateTtlSeconds` (optional, off by default per Q10): HEXPIRE on the written fields = value + time until the latest recorded time; on Redis < 7.4 one warning, then no TTL | bounded tag state for apps with unbounded tag names; the invalidation itself must never depend on HEXPIRE |
| D45 | (P6) `tagStateCacheMs` exists only for the use-cache handler (as drafted) | legacy pages are read once per render; stale local tag state there would serve invalidated HTML |
| D46 | (P6) C7 lowers prodlike to 6 MB with CONFIG SET (restored afterwards) | a brotli build is ~17 MB, so 16 MB no longer forces eviction; CONFIG SET avoids recreating the container |
| D47 | (P6) perf baseline `2.0.0-next.0.json` (with `--as`), perf `--compression` | the version field is still 1.1.0 until `changeset version`; the compression choice needs A/B measurements |
| D48 | merged `origin/master` (1.1.0 release, deterministic 7-1 oracle program) into `feat/v2` with a normal merge; the fixed program became the regular 7-1 test, the random durations programs stay as a second test | coordinator request; the fixed program always shows the 1.x difference, the random ones cover the rest |
| D49 | (P6) Stryker copies `tests/fixtures/next-build/.next` into its sandbox (negated ignore pattern) | the nightly mutation job failed its initial run: the fallback/prewarm tests could not read the fixture |
| D50 | (docs) README code blocks that are complete files (first line `// <path>`) are type-checked by contract-types against the tarball and each Next variant | 7-13 mapping ("compile README code blocks"); catches docs that drift from the API (checked by injecting `keyPrefix`) |
| D51 | (P3) `prepare-app --hot-dist` does not refresh the package code bundled into `instrumentation` | Next bundles instrumentation at build time; maintenance changes need a new app build (the handlers are loaded at runtime) |
| D52 | use-cache keys live one second past the entry lifetime; handler test defaults use 10 s timeouts and no circuit breaker; tests that order entries and invalidations by time use a fixed file time (build-output copies at 2026-01-01) or `clockAdvance()` (waits until `Date.now()` moved) instead of short sleeps | TTL: a deterministic oracle test showed a key expiring at exactly timestamp + revalidate while Next still answers a hit (reference k0=hit, ours k0=miss). Test determinism: CI run 36544312834 (unit, Node 24; `gh run view --log-failed`) failed "a prerendered path of a dynamicParams=false route is served stale instead" with `expected 1790671317671 to be -1` - the fixture copy was written in the same millisecond as the invalidation, and tag checks are strict like Next's (`expired > timestamp`), so the page was fresh. Semantics unchanged (equal = not expired, as in Next). bf89634 had guessed the TTL boundary was that failure; it was not, but the boundary mismatch is real and stays fixed |
| D53 | CI failures are GitHub annotations: vitest `github-actions` reporter (all projects) and Playwright `github` reporter when `GITHUB_ACTIONS` is set | job logs need auth, `/check-runs/{job_id}/annotations` does not - CI failures are diagnosed from the annotations first (coordinator request) |
| D54 | (P7, Q13) The coverage gate checks the **merged** report only, in a script (`coverage-summary.mjs --check`, rules and unit test in `scripts/lib/coverage-rules.mjs`): lines 90 / branches 85 / functions 90 globally and lines >= 80 per file; a missing report fails. No `thresholds` in `vitest.config.ts`. The ci `coverage` job is a need of `gate` (so of release.yml's gate too) | vitest thresholds would also apply to every single-layer `--coverage` run (unit on Node 22, each integration cell), which never reach the totals on their own; vitest's `perFile` applies every metric per file, while the plan asks for lines per file only |
| D55 | (P7, Q13) Mutation `thresholds.break: 70` in `stryker.config.mjs` - `stryker run` exits 1 below it, which fails the weekly nightly job (and files the `nightly-failure` issue). Mutation is not part of ci.yml or the release gate | ~70 min per run on a GitHub runner (90-minute budget); the plan only ever had it weekly |
| D56 | (P7) Exit pre mode on `next` before the production check finished; 2.0.0 is published from master: the main session merges `next` into master and release.yml there opens and publishes the "chore: release" PR. The "chore: release" PR that changesets/action opens against `next` after the pre-exit push is expected and is **not merged** (it would publish 2.0.0 from `next`) | coordinator plan; keeps the `latest` release on master where the 1.x releases came from |
| D57 | (P7, 7-15) `startCacheMaintenance` rechecks deferred builds on its own: up to `cleanup.rechecks` (default 3) passes, each `minIdleSeconds` + 1 s after the previous one on an unref'd timer, while builds stay deferred; a pass while Redis is not ready is skipped, a failing one is logged and the next one runs. `startCacheMaintenance` returns `{ done, stop }` (`done` = first run as before). The TTL cap stays as the safety net. Not done: recording last use in the registry (the handlers would need a write per read to keep it current) and `CLIENT NO-TOUCH` for the cap's EXPIRE (Redis >= 7.2 only and a second connection, since the shared client must keep touching keys for volatile-lru). The EXPIRE touches a key once per build (TTL is read first), so it delays a deletion by at most `minIdleSeconds`, which the first recheck covers | 7-15 production finding |
| D58 | (P7, 7-15) A recheck does not register the build again, and every pass keeps the newest registered build with its `keepPrevious` predecessors **plus** the running build (`keep = {buildId} + top(1 + keepPrevious)`); only kept builds other than the running and the newest one get the TTL cap. For a start pass (the running build is the newest) this is the old rule | an older instance's recheck after later deployments must neither reorder the registry nor remove the previous build of a later deployment (fault test "an older instance's recheck ...") |

---

## 9. Risks

- Dependency on Next internal paths (`next/dist/server/lib/incremental-cache/file-system-cache.js`) - detected early by matrix contract tests.
- Next 16.x minor changes (e.g. the negative-expire marker in 16.3) - canary matrix.
- Clock skew: entry timestamps and tag state both use the pod clock - assumes NTP on the nodes; C14 checks the tolerance.
- An AOF restart can roll back tag state (the production `values.yaml` documents the old-AOF-load trap) - impact is more misses.
- Build time: without caches the full matrix can exceed 60 min -> build only `app x Next` (6), Redis cells reuse artifacts.
- cacheComponents vs. segment config compatibility unconfirmed -> confirmed in P0c.
- The fleet's `node server.js` requires `prepare-app` to reproduce the standalone assembly (copying `.next/static` etc., same as docs `Dockerfile:31-40`).
- OIDC + changesets/action untested -> first publish as a prerelease (P1 checked the action source; the real publish is still pending).
- External users (~4.4k downloads/month) -> a 2.0 migration guide is required, 1.x hotfixes continue.
- ~~`@redis/client` 6.x unverified~~ -> resolved in P1 (D14). Remaining: the 6 cell does not run fault and oracle (mini-redis is RESP2-only). In 2.0 add `HELLO`/RESP3 to mini-redis or pin the test clients to RESP2.
- During a 1.0.x -> 1.1.0 rolling update old pods still write `now+expire` -> healed when a new pod reads it (D11). Old pods among themselves behave like 1.0.x.
- Configuring trusted publishing needs interactive 2FA - a 2FA-bypass token cannot replace `npm trust` or the web settings.
- Once Stryker's vitest-runner supports vitest 5 properly, go back to per-test coverage mode (the command runner runs everything per mutant).
- Windows Defender delays the first read of new files locally - exclude `.work/` (prepare-app absorbs it, but one static-site build takes 3+ minutes).
- (2.0) Next's `isStale === -1` handling differs between minors (16.1: serve once + background regeneration; 16.3: regenerate before answering). `onTagExpired: "auto"` avoids depending on it for expired tags; stale tags (profiles) still return -1 and so behave per minor. The canary cell and the 16.1/16.3 e2e matrix watch it.
- (2.0) The build-output fallback depends on `FileSystemCache`'s constructor options and `get(key, ctx)` shape (internal API). Guarded by the runtime contract per variant (D33) and the warning-and-off behavior when it cannot be loaded.
- (2.0) The render-start timestamp (D22) is per process: an entry set by an instance that did not see the miss (it cannot happen through Next's flow, which gets before it sets) would use the set time.
- (2.0) A circuit opened by one slow command skips Redis for `openMs` in every handler sharing that client - intended (A3), but a noisy neighbor on the Redis host can make an instance serve from the build output for 10 s at a time. `circuitBreaker: { openMs }` tunes it.
- (2.0) `tagStateTtlSeconds` below `ttl.maxSeconds` lets entries (and the build output of a long-running build) older than an expired tag field count as fresh again - documented on the option.
- (2.0) Rolling back from 2.x to a 1.x image: the 1.x docs cleanup deletes `docs:_tagstate`/`docs:_builds` like old builds (section 4) - loses 2.x invalidation times only.

---

## 10. Progress log

| Date | Phase | Content |
|---|---|---|
| 2026-09-29 | - | Audit, plan and test environment design finalized, this document written |
| 2026-09-29 | - | User decision: code (non-.md files) English only, `check-no-hangul` gate added |
| 2026-09-29 | P0a | Done (local). typecheck, build, lint, test (35), quality pass; negative tests of `check-pack` and `check-no-hangul` (exit 1 on injected violations). Build output byte-identical to the dist in the npm 1.0.6 tarball (= src behavior unchanged). CI not run yet (not pushed) |
| 2026-09-29 | P0b | Done (local, Windows Docker Desktop 28.5.2). `infra:up` (default, `all`, 16mb switch) and `infra:down`, integration smoke on Redis 7.2.16/8.4.7 (10 each), control smoke of 4 toxics (latency, timeout, reset_peer, bandwidth), fault layer clean over 5 repetitions, `test:all` 76 passed. **`infra:up` on Linux CI not verified yet (not pushed)** |
| 2026-09-29 | P0b | Linux CI verified: first run after adding the `feat/**` push trigger (Q18) [36513562634](https://github.com/mirunamu00/next-redis-cache/actions/runs/36513562634), all 8 jobs green (including the fault job's `infra:up -- redis84 toxiproxy` and integration 7.2/8.4) -> every P0b criterion met |
| 2026-09-29 | P0c | Done. 3 apps x 16.1.7 and 16.3.6 standalone builds (local Windows and CI Linux), `npm ls` single-instance check passes, 2-instance fleet e2e with the **npm 1.0.6 tarball**: 18 on 16.3 and 18 on 16.1 (13 smoke + 5 expected failures). cacheComponents constraint confirmed by build errors. contract-types 16.1 and 16.3 pass. CI [36520127962](https://github.com/mirunamu00/next-redis-cache/actions/runs/36520127962): 15 jobs green including setup, 2 contract, 3 e2e and perf. Differences from the plan in 6.2, 6.3, 6.4 and 8.1 |
| 2026-09-29 | P0d | Done. All of 7-1..7-13 + A2 reproduced on 1.0.6 (table in 6.9, confirmed with `NRC_REPRO=show`). 50 vitest expected failures (unit 9, fault 6, integration 17 x 2 versions, contract 1) + 10 chaos + 5 e2e + 2 tsc. Local `test:all` 87 passed + 50 expected failures, `test:chaos` 3 passed + 10 expected failures. perf baseline `tests/perf/baseline/1.0.6.json` (legacy hit 3 commands, use-cache page 8 commands, static-site build 123 keys, 116,060,896 bytes) committed; the CI perf gate passes on Linux against the same baseline |
| 2026-09-29 | P0e | Done. nightly completed once via a `feat/**` push: [36521161066](https://github.com/mirunamu00/next-redis-cache/actions/runs/36521161066) 33 of 34 jobs green, 1 skipped (report, schedule only), 22 min - ci level=full (12 e2e cells = 3 apps x [16.1, 16.3] x [7.2, 8.4], contract 16.1, 16.3, canary, perf + timing, merged coverage), all chaos, quarantine, e2e on Node 24 (3 apps), mutation (22.3 min), canary e2e. release has `needs: [gate, chaos]`, so it cannot publish without ci full + the chaos subset (actionlint passes). Mutation score 27.6% (local, 671 mutants - Docker-free tests without the integration layer, report-only) |
| 2026-09-29 | P1 | Ready to publish (feat/test-infra). Fixes 7-1, 7-3, 7-4, 7-7, 7-9, 7-10 + packaging (conditional types, engines, repository, peer `@redis/client ^5 \|\| ^6`) + OIDC release.yml + README (the P1 part of 7-13) + changeset (minor) + perf baseline 1.1.0. Conversion status and local results in 6.9, decisions D11..D20, publishing in section 11. CI: [36528242579](https://github.com/mirunamu00/next-redis-cache/actions/runs/36528242579) (17 jobs green, including the @redis/client 6 cell and unit-windows), [36528501162](https://github.com/mirunamu00/next-redis-cache/actions/runs/36528501162) green |
| 2026-09-29 | P2 | Done on `feat/v2` (worktree): 3798f43 - factory handlers, envelope, two-field tag state, Next 16 semantics, run pipeline + circuit, connectRedis, logger/onEvent, TTL policy. 7-1, 7-2, 7-5, 7-6, 7-8, 7-11, 7-12, 7-13 converted (6.9). Merged origin/master (1.1.0 release) in edc9da0 (D48) |
| 2026-09-29 | P3 | Done: 175ed44 - build-output fallback + re-seed, prewarmFromBuildOutput, v2 test-app wiring, runtime contract per variant, chaos C3/C4/C10; A2, C1, C9, C6, C13, C11/C12 (I1) converted. Local: e2e 20/20 (16.3), chaos 21/21 |
| 2026-09-29 | P4 | Done: 174b511 - cleanupOldBuilds, whenReady, startCacheMaintenance, 1.x layouts, chaos C8. CI [36537773829](https://github.com/mirunamu00/next-redis-cache/actions/runs/36537773829) green (pr level). Nightly [36537774886](https://github.com/mirunamu00/next-redis-cache/actions/runs/36537774886) failed: full-cc e2e on 16.1 (updateTag answered stale once -> D43) and the weekly mutation job (fixture missing in the Stryker sandbox -> D49); everything else green |
| 2026-09-29 | P6 | Done: 57623bd - brotli default (D42), tagStateTtlSeconds/HEXPIRE, onTagExpired "auto" (D43), perf --compression + baseline 2.0.0-next.0 (A9 -88.3%), chaos C7/C14. 3ac5564 Stryker sandbox fix. Local after the fix: e2e 20/20 on 16.3 and 20/20 on 16.1, chaos 21/21, integration 44 x 2 versions, contract-types 16.1 + 16.3 (types, runtime, README) |
| 2026-09-29 | docs | 71971bb README for 2.0 + MIGRATION.md + major changeset + README type check (D50); 682dd24 chaos subset/header; e6fe77f test defaults (10 s timeouts, no circuit) and release.yml on `next`. CI [36542990088](https://github.com/mirunamu00/next-redis-cache/actions/runs/36542990088) green at 682dd24. All layers together: 301 tests, coverage lines 96.5 % / branches 88.7 % / functions 94.8 %, every file >= 83 % lines |
| 2026-09-29 | CI | Nightly [36542991375](https://github.com/mirunamu00/next-redis-cache/actions/runs/36542991375) at 682dd24 (triggered by the chaos.yml change, D8): **success**, every job - ci level=full (e2e 12 cells: 3 apps x Next 16.1/16.3 x Redis 7.2/8.4, contract 16.1/16.3/canary with runtime + README checks, integration 7.2/8.4/client 6, perf), chaos all 21 scenarios on Linux, quarantine x20, e2e on Node 24, weekly mutation, canary e2e. CI (pr level) green at 682dd24, bf89634, a72d005, 793096e; red once at 486e97f (unit Node 24, flaky same-millisecond test, diagnosed from `gh run view 36544312834 --log-failed`, fixed in 793096e, D52). From here on failures are diagnosed from annotations / `gh` logs (D53) |
| 2026-09-29 | mutation | Local full run at 57623bd (+ tests up to 3ac5564): **71.6 %** (1386 killed + 11 timeouts of 1951, 83 min, command runner) vs 27.6 % for 1.x. Weakest files were integration-only: tag-writer 16.7 %, prewarm 32.8 % -> Docker-free unit tests in 5cddcf3 raised them to 91.7 % / 70.5 % (targeted run), about 73.7 % overall. Other files: runner 84.6, config 89.4, logger 86.1, envelope 79.1, tag-state 79.1, maintenance 76.2, build-output 69.7, legacy-handler 66.5, use-cache-handler 61.8, redis 54.1, legacy-cleanup (deprecated) 18.2 |
| 2026-09-29 | P1 | User decision Q20: Markdown and commit messages English too. This document, `tests/perf/README.md` and `tests/fixtures/next-build/README.md` translated; `check-no-hangul` covers Markdown; `check-commit-messages` added (`origin/master..HEAD`); branch history rewritten to English and force-pushed (e2e277a) |
| 2026-09-29 | P5 | (main session) `next` created, pre mode entered (8846940), `2.0.0-next.0` published from PR #8 (b3bb595); docs master c943f3c migrated to it and deployed; production check passed with two findings, 7-14 and 7-15 (section 2.2). 24 h and the rollback rehearsal pending |
| 2026-09-29 | P7 | On `next`: Docker-free tests for connectRedis (scripted client), use-cache and legacy handler details (3df7f7f, 4ba3cb1). Targeted Stryker run of use-cache-handler, legacy-handler and redis.ts: **64.5 % -> 90.8 %** (412 -> 580 of 639 mutants detected, before/after runs on the same machine; use-cache-handler 64.1 -> 90.1, legacy-handler 66.5 -> 90.1, redis 55.4 -> 95.9; the later commits killed more of the listed survivors). Merged coverage of every non-chaos layer (local, Redis 7.2 + 8.4): lines 97.11 -> 98.44 %, branches 89.74 -> 92.89 %, functions 94.81 -> 96.78 % (before = CI run 36552923837's merged report at b3bb595); every file with lines >= 91 % |
| 2026-09-29 | P7 | 7-14 and 7-15: reproductions first (c296062: unit, fault, integration on Redis 7.2 and 8.4 - the integration run also confirmed that EXPIRE refreshes OBJECT IDLETIME), fixes 3b23b5f and d202c0c (rechecks D57, keep set D58), concurrent recheck tests (fe77650), chaos C15 (99a7a19, fails on the published 2.0.0-next.0, passes with the fix). Gates blocking (6d80e05, D54, D55); negative checks: the coverage gate exits 1 on an injected report below a threshold and passes on CI run 36552923837's report, `stryker run` on `legacy-cleanup.ts` alone exits 1 ("Final mutation score 18.18 under breaking threshold 70"). A first draft of the gate would have failed on the re-export-only entries (v8 reports 0 of 0 lines as 0 %) - such files are skipped. Pre mode exited (fe894a4, D56) |
| 2026-09-29 | P7 | Flakiness found by repeated local runs of the mutation test set (no retries): `tests/unit/redis.test.ts` advanced fake time before `open()` had set its timer (the dynamic import can take a macrotask; 1 of 11 runs hung in afterEach) - fixed in 6646a9c; the envelope property test found an own `"__proto__"` key being lost (assignment sets the prototype) - reproduced in 5401666, fixed in ccad405, the key is now always part of the arbitrary |
| 2026-09-29 | P7 | Pushed `next` at b30bb16: CI [36563097446](https://github.com/mirunamu00/next-redis-cache/actions/runs/36563097446) green (merged coverage in CI: lines 98.44 / branches 92.91 / functions 96.8 %, `coverage` passed as a gate need), Release [36563097810](https://github.com/mirunamu00/next-redis-cache/actions/runs/36563097810) green (ci level full + chaos subset incl. C15) - changesets/action opened PR #9 "chore: release" (2.0.0) against `next`, not merged (D56); its pull_request CI is `action_required` (bot PR). Nightly with the weekly jobs dispatched on `next` [36563674724](https://github.com/mirunamu00/next-redis-cache/actions/runs/36563674724): every job green; **mutation 85.67 %** (1739 of 2030; before: 71.45 %, 1394 of 1951, nightly 36542991375), "Final mutation score of 85.67 is greater than or equal to break threshold 70", 71 min of the 90-minute budget. Local full run at ccad405: 85.07 % (68 min). Per file (local): redis 98.7, legacy-handler 94.1, use-cache-handler 93.2, tag-writer 91.7, config 88.8, logger 88.6, runner 85.9, maintenance 81.6, envelope 81.4, tag-state 79.1, build-output 74.3, prewarm 70.5, legacy-cleanup (deprecated) 18.2 |

---

## 11. Publishing 1.1.0 (P1 result)

Precondition: `feat/test-infra` merged into master (= release.yml runs). **Nothing is published from this branch** (Q18).

### 11.1 Recommended - trusted publishing (OIDC) + provenance

1. Register the trusted publisher (once, by the user - needs a 2FA account login):
   - Web: npmjs.com -> `@mirunamu/next-redis-cache` -> Settings -> Trusted Publisher -> GitHub Actions, Organization or user `mirunamu00`, Repository `next-redis-cache`, Workflow filename `release.yml`, Environment empty.
   - Or the CLI (npm >= 11.15.0; the local Node 22.21 needs npm 11):
     ```
     npx -y npm@11.20.0 login
     npx -y npm@11.20.0 trust github @mirunamu/next-redis-cache --file release.yml --repository mirunamu00/next-redis-cache --allow-publish
     npx -y npm@11.20.0 trust list @mirunamu/next-redis-cache
     ```
     (Payload checked with `--dry-run --json`: `{"package":"@mirunamu/next-redis-cache","file":"release.yml","repository":"mirunamu00/next-redis-cache","permissions":["createPackage"]}`. A granular token that bypasses 2FA is rejected.)
2. Merge and push to master -> release.yml: after the gate (ci full) and chaos (C1, C9, C11, C12) pass, changesets/action opens the "chore: release" PR (1.0.6 -> 1.1.0, CHANGELOG). (The repository setting "Allow GitHub Actions to create and approve pull requests" must be on.)
3. Merge that PR -> release.yml again -> no pending changesets, so `changeset publish` -> npm 11.20.0 publishes through OIDC with provenance, creates the `v1.1.0` tag and the GitHub release.
4. Verify: `npm view @mirunamu/next-redis-cache@1.1.0 dist.attestations` (provenance), "Built and signed on GitHub Actions" on the npmjs.com page.
5. Afterwards (user): package Settings -> "Require two-factor authentication and disallow tokens", revoke the `NPM_TOKEN` secret and token.

### 11.2 Fallback - local publish (token, no provenance)

When 1.1.0 has to go out before trusted publishing is configured. The token is never written to a file, only passed through the environment, with a temporary userconfig outside the repository.

```bash
git switch master && git pull --ff-only          # after merging feat/test-infra
git switch -c release/1.1.0
npm ci
# changelog-github reads commit/PR data from the GitHub API and needs GITHUB_TOKEN (a read-only PAT is enough).
GITHUB_TOKEN=<github-pat> npx changeset version   # package.json 1.1.0, CHANGELOG.md, deletes .changeset/hotfix-1-1-0.md
npm run build && npm run quality && npm test
git commit -am "chore: release 1.1.0"
# Publish: the temporary userconfig outside the repo only references the token variable (value via env)
NPMRC="$(mktemp)"; printf '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n' > "$NPMRC"
NPM_TOKEN=<npm-token> NPM_CONFIG_USERCONFIG="$NPMRC" npm publish --access public   # prepublishOnly builds again
rm -f "$NPMRC"
git tag v1.1.0
```

- Without a GitHub token, instead of `changeset version`: `npm version 1.1.0 --no-git-tag-version`, move the body of `.changeset/hotfix-1-1-0.md` to the top of `CHANGELOG.md` under `## 1.1.0` / `### Minor Changes`, delete the file.
- In PowerShell set the same values with `$env:NPM_TOKEN` and `$env:NPM_CONFIG_USERCONFIG`, then `Remove-Item Env:NPM_TOKEN`.
- Order matters: pushing the version commit to master runs release.yml. **Finish the local publish first** so the release job's `changeset publish` finds 1.1.0 already published and does nothing (pushing first without trusted publishing makes the publish step fail on authentication).
- A local publish cannot produce provenance (`--provenance` only works on supported CI).

---

## 12. 2.0.0-next prerelease and handoff (P5, P7)

### 12.1 State of `feat/v2`

(Written before `next` existed; kept for the record - the current state is in 12.2 and 12.4.) Everything of P2, P3, P4 and P6 is on `feat/v2` (pushed; never merged into master or `next`, nothing published). No reproduction marker is left in any layer (6.9). Package: `version` is still 1.1.0 (from master); `.changeset/v2-major.md` (major) makes it 2.0.0 / 2.0.0-next.0. Gates: typecheck, lint, build, quality (publint, attw, size-limit, check-pack, check-no-hangul), check-commit-messages, check-quarantine.

### 12.2 Publishing 2.0.0-next.N (main session)

Prerequisite: npm trusted publishing is configured for `release.yml` (section 11, done for 1.1.0) - it covers every branch of that workflow.

1. Create the `next` branch from `feat/v2` (or merge `feat/v2` into it): `git switch -c next origin/feat/v2`.
2. Enter pre mode **on `next` only**: `npx changeset pre enter next` -> commit `.changeset/pre.json` (`chore: enter changesets pre mode (next)`).
3. `git push origin next` -> ci.yml (push to `next`) and release.yml (now also on `next`): gate = ci level full + chaos subset (startup, rolling, degraded, pressure), then changesets/action opens "chore: release (next)" (`2.0.0-next.0`, CHANGELOG). Merge it -> the next run publishes `2.0.0-next.0` with dist-tag `next` and provenance.
4. Later prereleases: add changesets on `next` -> `2.0.0-next.1`, ...
5. Check: `npm view @mirunamu/next-redis-cache dist-tags` (`latest` must still be 1.1.0), `npm view @mirunamu/next-redis-cache@2.0.0-next.0 dist.attestations`.

Note: `npm version` runs the `version` lifecycle script (`changeset version`); use `--ignore-scripts` if a version is ever bumped by hand.

Done (main session): `next` was created from `feat/v2`, pre mode entered (8846940), the "chore: release (next)" PR #8 merged (b3bb595) and `2.0.0-next.0` published with dist-tag `next` (tag `v2.0.0-next.0`); docs master c943f3c runs it in production (12.3, section 2.2).

### 12.3 P5 - docs app configuration (main session / docs-expert)

Install `@mirunamu/next-redis-cache@2.0.0-next.N` (exact pin). Replace `cache/resilient-cache-handler.mjs`, `cache/redis-connect.mjs`, `cache/build-keys.mjs` and `tests/unit/*` with:

```js
// cache/config.mjs
import { connectRedis } from "@mirunamu/next-redis-cache/redis";

export const cacheConfig = {
  client: () => connectRedis(process.env.REDIS_URL, { label: "docs" }), // null without REDIS_URL
  namespace: process.env.CACHE_NAMESPACE || "docs", // "docs-canary" for the port-forward check
  buildId: process.env.BUILD_ID || undefined, // CI sets the commit SHA; also read from .next/BUILD_ID
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

`src/instrumentation-node.ts`: keep the missing-REDIS_URL banner, replace `cleanup()` and `prewarm()` by `startCacheMaintenance({ config: cacheConfig })` (cleanup on, prewarm off - Q9). next.config stays as it is (`cacheHandler`, `cacheHandlers.default`, `cacheMaxMemorySize: 0`, `generateBuildId`).

What changes in production (Redis 8.4, 384 MB volatile-lru, 1 replica):
- keys `docs:<sha>:e:<path>` (brotli, TTL 30 days for static pages) + `docs:_tagstate` + `docs:_builds`. The existing `docs:_builds` registry (docs' build-keys.mjs) has the same format and is reused; the 1.x keys `docs:<sha>:/...` and `docs:<sha>:_tags|_tagTtls|_revalidated|uc:...` are removed by the first 2.x maintenance runs once idle for 30 min (the previous build is kept with a 1-day TTL cap).
- The first 2.x pod starts with an empty cache for its build: every page comes from the build output and is re-seeded (`fallback` events, then `hit`). Expect Redis memory for one build around 15% of 1.x.
- Logs: `[next-redis-cache] ...` transition lines; the cleanup logs one line per start (`cleanup: deleted N keys; ...`).
- Smoke after rollout (5.7, 7): sitemap 200, `redis-cli --scan --pattern 'docs:*' | cut -d: -f2 | sort | uniq -c`, `MEMORY USAGE`, logs. Rollback: revert the helm-chart auto-tag commit; see MIGRATION.md "Rolling update from 1.x" (a 1.x cleanup deletes `docs:_tagstate`/`docs:_builds` - harmless for docs, which does not invalidate tags).

### 12.4 P7 - 2.0.0 stable

Done on `next` (P7 run, 2026-09-29; commits in section 10):

- [x] Q13: coverage and mutation gates blocking - the ci `coverage` job gates the merged report (D54) and is a need of `gate`; `thresholds.break: 70` fails the weekly mutation job (D55). Before that, Docker-free tests for use-cache-handler, legacy-handler and redis.ts (targeted mutation score of the three files 64.5 % -> 90.8 %; whole package in CI 71.45 % -> 85.67 %, section 10).
- [x] 7-14 and 7-15 from the production check fixed (section 2.2, D57, D58), chaos C15; one flaky unit test (fake time before the dynamic import) and the envelope's `"__proto__"` key (property test) fixed on the way.
- [x] `npx changeset pre exit` on `next` (fe894a4): `.changeset/pre.json` mode `exit`; pending changesets `v2-major` (major) + `maintenance-rechecks` (patch) -> 2.0.0.

Left for the main session, in this order:

- [ ] P5 done (A10, 24 h in production, one rollback rehearsal).
- [ ] Do **not** merge the "chore: release" PR that changesets/action opens against `next` after the pre-exit push (D56): it would publish 2.0.0 from `next`. Close it, or leave it until `next` is merged.
- [ ] Merge `next` into master (normal merge) and push -> release.yml on master: gate (ci level full, now with the coverage gate) + chaos subset (incl. C15) -> changesets/action opens "chore: release" (2.0.0, CHANGELOG, deletes the changesets and `pre.json`) -> merge it -> the next run publishes 2.0.0 as `latest` with provenance.
- [ ] Check: `npm view @mirunamu/next-redis-cache dist-tags` (`latest` 2.0.0; `next` still points at 2.0.0-next.0 - optionally `npm dist-tag add @mirunamu/next-redis-cache@2.0.0 next`, which needs an interactive npm login), `npm view @mirunamu/next-redis-cache@2.0.0 dist.attestations`.
- [ ] docs `^2.0.0`: it picks up the 7-14 log wording and the 7-15 rechecks (docs keeps the default `rechecks: 3`; nothing to configure).
- [ ] Afterwards: delete the `next` branch or keep it for 2.1 prereleases (enter pre mode again then).
- [ ] Remaining known gaps: `@redis/client` 6 is covered by typecheck + integration only (mini-redis speaks RESP2; section 9); `cleanupOldBuildKeys` removal is planned for 3.0; deprecated `legacy-cleanup.ts` has a low mutation score (18 %, integration-tested only).
