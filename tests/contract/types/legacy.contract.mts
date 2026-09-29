// Contract (types): the legacy handler class must be usable where Next expects its `cacheHandler`
// class: constructed with CacheHandlerContext, exposing get/set/revalidateTag/resetRequestCache.
//
// Expected failures use `// @ts-expect-error [7-x]` (the type-level `it.fails`): once the bug is fixed
// the directive becomes unused, tsc fails, and the marker must be removed in the fixing commit.
import type { CacheHandler, CacheHandlerContext } from "next/dist/server/lib/incremental-cache/index.js";
import LegacyDefault, { LegacyCacheHandler } from "@mirunamu/next-redis-cache";

type NextCacheHandlerClass = new (ctx: CacheHandlerContext) => Pick<CacheHandler, "get" | "set" | "revalidateTag" | "resetRequestCache">;

// @ts-expect-error [7-8] 1.x declares its own context type (index signature) instead of Next's CacheHandlerContext
export const named: NextCacheHandlerClass = LegacyCacheHandler;
// @ts-expect-error [7-8] same class through the default export
export const byDefault: NextCacheHandlerClass = LegacyDefault;
