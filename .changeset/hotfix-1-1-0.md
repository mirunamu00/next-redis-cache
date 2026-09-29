---
"@mirunamu/next-redis-cache": minor
---

Hotfix release: fixes for tag invalidation, connection handling, prewarming and old-build cleanup. The Redis key layout is unchanged, so 1.1.0 can run next to 1.0.x instances during a rolling update.

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
