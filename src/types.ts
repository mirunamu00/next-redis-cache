/**
 * Public types shared by every entry point.
 */
import type { RedisClientType } from "@redis/client";

/**
 * Any `@redis/client` 5.x/6.x client (RESP2 or RESP3, with or without modules). The handlers only
 * use plain commands (GET, SET, HMGET, HSET, ...), so the client's generic parameters do not matter.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRedisClient = RedisClientType<any, any, any, any, any>;

/**
 * Where the handlers get their Redis client from:
 * - a client instance (connected or not; the package never calls `connect()` itself),
 * - a function returning a client, `null`/`undefined` (no Redis) or a promise of either -
 *   for example `() => connectRedis(process.env.REDIS_URL)`. It is called on first use and again
 *   until it returns a client; the first client returned is kept.
 */
export type ClientSource =
  | AnyRedisClient
  | null
  | undefined
  | (() => AnyRedisClient | null | undefined | Promise<AnyRedisClient | null | undefined>);

export type LogLevel = "debug" | "info" | "warn" | "error";

/** A subset of console. Missing levels are silent. */
export type Logger = Partial<Record<LogLevel, (...args: unknown[]) => void>>;

export type HandlerName = "legacy" | "use-cache";

/**
 * Observability events (metrics only through this hook, Q12). The hook runs synchronously on the
 * request path: keep it cheap. Exceptions thrown by it are ignored.
 */
export type CacheEvent =
  | { type: "hit"; handler: HandlerName; key: string }
  | { type: "stale"; handler: HandlerName; key: string; reason: "tag" }
  | {
      type: "miss";
      handler: HandlerName;
      key: string;
      reason: "absent" | "expired" | "tag" | "unavailable" | "error" | "format" | "disabled";
    }
  | { type: "set"; handler: HandlerName; key: string; bytes: number }
  | { type: "fallback"; handler: "legacy"; key: string; state: "fresh" | "stale" | "unknown" }
  | { type: "reseed"; handler: "legacy"; key: string }
  | { type: "error"; handler: HandlerName | "maintenance"; op: string; key?: string; error: unknown }
  | { type: "circuit"; state: "open" | "closed"; reason: string };

export interface TimeoutOptions {
  /** Timeout of read commands (GET, HMGET) in ms. Default 1000. */
  readMs?: number;
  /** Timeout of write commands (SET, HSET, UNLINK) in ms. Default 2000. */
  writeMs?: number;
}

export interface CircuitBreakerOptions {
  /** After a command times out, Redis is skipped for this long (ms). Default 10000. */
  openMs?: number;
}

export interface FallbackOptions {
  /**
   * Serve prerendered pages and route handlers from the build output (`.next/server/app`) when
   * Redis has no entry or is unavailable. Default true (production only; never in dev or during the build).
   */
  buildOutput?: boolean;
  /** Write a fresh build-output entry back to Redis (SET NX) when Redis is usable. Default true. */
  reseed?: boolean;
}

export interface TtlOptions {
  /** TTL of entries without a numeric revalidate (static pages). Default 30 days. */
  staticSeconds?: number;
  /** Upper bound of every TTL. Default 365 days. */
  maxSeconds?: number;
  /** TTL of an entry with numeric revalidate. Default `s => Math.floor(s * 1.5)`. */
  estimateExpire?: (revalidateSeconds: number) => number;
}

export type Compression = "none" | "gzip" | "brotli";

export interface RedisCacheConfig {
  /** The Redis client, or a function that provides it (see ClientSource). */
  client: ClientSource;
  /**
   * Key namespace shared by every build of the app, e.g. "docs". Keys are
   * `{namespace}:{buildId}:e:{key}` (legacy), `{namespace}:{buildId}:u:{key}` ("use cache"),
   * `{namespace}:_tagstate` and `{namespace}:_builds`. Must not contain `*?[]\` or whitespace.
   */
  namespace: string;
  /**
   * Build identifier (second key segment). Default: `process.env.BUILD_ID`, then the `BUILD_ID` file
   * of the Next.js build output (`<distDir>/BUILD_ID`). Must not contain ":" and must not start with "_".
   */
  buildId?: string;
  timeouts?: TimeoutOptions;
  /** `false` disables the circuit breaker (every call waits up to its timeout). */
  circuitBreaker?: CircuitBreakerOptions | false;
  /** `false` disables the build-output fallback and re-seeding. */
  fallback?: FallbackOptions | false;
  ttl?: TtlOptions;
  /**
   * What the legacy handler answers for a page or route handler whose tag expired (updateTag,
   * revalidatePath, revalidateTag without a profile):
   * - "auto" (default): a miss, so Next renders it before answering (Next's own file-system cache does
   *   the same) - except for a prerendered path of a `dynamicParams = false` route, where a miss is a
   *   404: that one is answered like "stale". Uses prerender-manifest.json; without it, like "stale".
   * - "stale": the old entry with lastModified -1 (Next 16.3+ renders before answering, 16.1 answers
   *   with it once and regenerates in the background) - never a 404.
   * - "miss": always a miss (a `dynamicParams = false` page answers 404 until it is rendered again).
   * Tags marked stale by revalidateTag(tag, profile) are always answered like "stale". Fetch entries with
   * an expired tag are always a miss.
   */
  onTagExpired?: "auto" | "stale" | "miss";
  /**
   * Compression of stored values (entries of 1 KiB and more). Default "brotli" (quality 4): about 85%
   * less Redis memory for typical HTML/RSC payloads at no measurable latency cost. Entries written with
   * any setting stay readable with any other.
   */
  compression?: Compression;
  /**
   * Per-field TTL of the shared tag state (Redis >= 7.4, HEXPIRE), counted from the latest time an
   * invalidation records. Default: none - the tag state is bounded by the number of tags (Q10). Choose a
   * value above ttl.maxSeconds: once a field expires, entries older than that invalidation (including the
   * build output of a build that is still running) count as fresh again.
   */
  tagStateTtlSeconds?: number;
  /**
   * Logger (default: console for info/warn/error, debug only with NEXT_PRIVATE_DEBUG_CACHE).
   * `false` silences the package.
   */
  logger?: Logger | false;
  onEvent?: (event: CacheEvent) => void;
  /**
   * Turns the handlers into no-ops (every get is a miss, nothing is written, nothing connects).
   * Default: true while `next build` runs (`NEXT_PHASE === "phase-production-build"`).
   */
  disabled?: boolean | (() => boolean);
}

export interface UseCacheConfig extends RedisCacheConfig {
  /**
   * Stale-while-revalidate for "use cache" entries (default true): an entry past its revalidate
   * time is returned and Next regenerates it in the background. With `false` such an entry is a
   * miss (the behavior of Next's in-memory default handler).
   */
  swr?: boolean;
  /**
   * Cache tag state in memory for this many ms (default 0 = always read it from Redis). A value
   * above 0 saves a Redis round trip per read at the cost of seeing invalidations made by other
   * instances up to that much later. Invalidations made by this instance are seen immediately.
   */
  tagStateCacheMs?: number;
}

/** Context Next.js passes to the legacy handler constructor (only the fields the package reads). */
export interface LegacyHandlerContext {
  dev?: boolean;
  serverDistDir?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fs?: any;
}

/** Context of legacy `get` (Next's GetIncremental*CacheContext; only the fields the package reads). */
export interface LegacyGetContext {
  kind?: string;
  softTags?: string[];
  tags?: string[];
  isRoutePPREnabled?: boolean;
  isFallback?: boolean;
}

/** Context of legacy `set` (Next's SetIncremental*CacheContext; only the fields the package reads). */
export interface LegacySetContext {
  tags?: string[];
  revalidate?: number | false;
  cacheControl?: { revalidate?: number | false; expire?: number };
  fetchCache?: boolean;
  isRoutePPREnabled?: boolean;
  isFallback?: boolean;
}

/** What the legacy `get` returns (Next's CacheHandlerValue). */
export interface LegacyCacheValue {
  lastModified: number;
  age?: number;
  cacheState?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
}

export interface LegacyCacheHandlerInstance {
  get(cacheKey: string, ctx?: LegacyGetContext): Promise<LegacyCacheValue | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set(cacheKey: string, data: any, ctx?: LegacySetContext): Promise<void>;
  revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
  resetRequestCache(): void;
}

/** The class Next.js instantiates for `cacheHandler` (the default export of the handler file). */
export type LegacyCacheHandlerClass = new (ctx?: LegacyHandlerContext) => LegacyCacheHandlerInstance;

/** Next.js "use cache" CacheEntry (next/dist/server/lib/cache-handlers/types). */
export interface UseCacheEntry {
  value: ReadableStream<Uint8Array>;
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

/** Next.js "use cache" CacheHandler (next/dist/server/lib/cache-handlers/types). */
export interface UseCacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<UseCacheEntry | undefined>;
  set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<number>;
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}
