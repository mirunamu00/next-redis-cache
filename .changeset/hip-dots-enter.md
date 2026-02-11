---
"@mirunamu/next-redis-cache": major
---

Initial release of @mirunamu/next-redis-cache

- Legacy cache handler (`LegacyCacheHandler`) for Next.js ISR and Route Handlers
- Use-cache handler (`createUseCacheHandler`) for Next.js `use cache` directive
- Distributed tag-based invalidation via Redis Hash (`TagManager`)
- Instrumentation helpers: `registerInitialCache`, `cleanupOldBuildKeys`
- Stream/Buffer serialization utilities for Redis storage
- Configurable key prefix, timeout, and Redis client injection
