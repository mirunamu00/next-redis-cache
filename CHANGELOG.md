# @mirunamu/next-redis-cache

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
