# @mirunamu/next-redis-cache

## 1.0.0

### Major Changes

- [`3f48bd7`](https://github.com/mirunamu00/next-redis-cache/commit/3f48bd7258925f9b46d9775288e365c41cb4fcac) Thanks [@geonwooo-park](https://github.com/geonwooo-park)! - Initial release of @mirunamu/next-redis-cache

  - Legacy cache handler (`LegacyCacheHandler`) for Next.js ISR and Route Handlers
  - Use-cache handler (`createUseCacheHandler`) for Next.js `use cache` directive
  - Distributed tag-based invalidation via Redis Hash (`TagManager`)
  - Instrumentation helpers: `registerInitialCache`, `cleanupOldBuildKeys`
  - Stream/Buffer serialization utilities for Redis storage
  - Configurable key prefix, timeout, and Redis client injection
