---
"@mirunamu/next-redis-cache": patch
---

Fixes since 2.0.0-next.0 (the first two found while verifying it in production):

- `startCacheMaintenance` checks builds it deferred (still read at startup) again `minIdleSeconds` later, up to `cleanup.rechecks` (3) times, and removes them once idle instead of leaving them to the one-day TTL cap. Redis counts the TTL cap's EXPIRE as an access, so a build capped as the previous one looked in use when the next build started soon after. `startCacheMaintenance` now returns `{ done, stop }`; a recheck never registers the build again and keeps a later deployment's previous build.
- `connectRedis` no longer logs the first connection after a slow start as "connected ... again".
- The entry envelope keeps an own `"__proto__"` key of a cached object as data; it used to set the prototype of the copy (found by the property test, not a shape Next.js produces).
