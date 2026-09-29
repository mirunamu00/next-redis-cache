/**
 * Legacy `cacheHandler` (singular): ISR pages, route handlers and the fetch data cache.
 *
 * createCacheHandler(config) returns the class Next.js instantiates (once per request) - all state
 * lives in the factory closure, not in static fields, so several handlers can coexist.
 *
 * get   GET entry (+ HMGET of the request's tags, same round trip) -> HMGET of the entry's remaining
 *       tags (second round trip, only when needed). Tag semantics are Next's own (ROADMAP.md 5.2):
 *         FETCH       expired tag -> miss, stale tag -> served stale (lastModified -1)
 *         pages/routes expired or stale tag -> served stale (lastModified -1: Next answers with it and
 *                     regenerates in the background) - or a miss with onTagExpired: "miss"
 *       Returning null for a prerendered page would make a `dynamicParams = false` route answer 404.
 * set   one SET with EX (TTL from the write, 7-11) - no side hashes, nothing to go out of sync (7-12).
 * revalidateTag(tags, durations)  one HSET of the shared tag state; no key is deleted (7-5, 7-6).
 *
 * Entries regenerated after a miss or a stale answer are stored with the time of that answer as
 * lastModified (the time the render started, not when it finished): an invalidation that lands while
 * the render is running is newer than the entry, so the entry is served stale and regenerated again
 * instead of passing as fresh (7-6, chaos C13).
 */
import { buildIdResolver, resolveConfig, type ResolvedConfig } from "./config";
import { decodeEnvelope, encodeEnvelope, EnvelopeFormatError } from "./envelope";
import { entryKey, tagStateKey } from "./keys";
import { FailureReporter, reportFailure } from "./logger";
import { isUnavailable, Runner } from "./runner";
import { areTagsExpired, areTagsStale, missingTags, parseTagFields, tagFields, updateFields, type TagTable } from "./tag-state";
import { setOptions, ttlSeconds } from "./ttl";
import type {
  LegacyCacheHandlerClass,
  LegacyCacheHandlerInstance,
  LegacyCacheValue,
  LegacyGetContext,
  LegacyHandlerContext,
  LegacySetContext,
  RedisCacheConfig,
} from "./types";

const TAGS_HEADER = "x-next-cache-tags";

/** Metadata stored next to a legacy value. */
export interface LegacyMeta {
  lastModified: number;
  tags: string[];
  revalidate?: number | false;
}

/**
 * Remembers when this process answered a key with a miss or a stale entry (Next renders it right
 * after). The following set of that key uses this time as lastModified.
 */
class RenderStarts {
  static readonly WINDOW_MS = 5 * 60_000;
  static readonly MAX_KEYS = 10_000;
  readonly #starts = new Map<string, number>();

  mark(key: string, now: number): void {
    const t = this.#starts.get(key);
    if (t !== undefined && now - t <= RenderStarts.WINDOW_MS) return; // keep the earliest pending render
    this.#starts.delete(key);
    if (this.#starts.size >= RenderStarts.MAX_KEYS) {
      const oldest = this.#starts.keys().next().value;
      if (oldest !== undefined) this.#starts.delete(oldest);
    }
    this.#starts.set(key, now);
  }

  take(key: string, now: number): number {
    const t = this.#starts.get(key);
    this.#starts.delete(key);
    return t !== undefined && now - t <= RenderStarts.WINDOW_MS ? Math.min(t, now) : now;
  }
}

function headerTags(headers: unknown): string[] {
  const v = (headers as Record<string, unknown> | undefined)?.[TAGS_HEADER];
  if (Array.isArray(v)) return v.filter((t): t is string => typeof t === "string" && t.length > 0);
  if (typeof v === "string" && v) return v.split(",").filter(Boolean);
  return [];
}

function unique(...lists: ReadonlyArray<readonly string[] | undefined>): string[] {
  const out = new Set<string>();
  for (const list of lists) for (const t of list ?? []) if (t) out.add(t);
  return [...out];
}

/** Everything shared by the handler instances of one createCacheHandler() call. */
export class LegacyCore {
  readonly cfg: ResolvedConfig;
  readonly runner: Runner;
  readonly reporter: FailureReporter;
  readonly #renders = new RenderStarts();
  readonly #buildId: (distDir?: string) => string;
  /** First non-empty context seen (Next passes the same one to every instance). */
  context: LegacyHandlerContext = {};

  constructor(cfg: ResolvedConfig) {
    this.cfg = cfg;
    this.runner = new Runner(cfg);
    this.reporter = new FailureReporter("legacy", cfg.logger);
    this.#buildId = buildIdResolver(cfg);
  }

  observe(ctx: LegacyHandlerContext | undefined): void {
    if (ctx?.serverDistDir && !this.context.serverDistDir) this.context = ctx;
  }

  distDir(): string | undefined {
    const server = this.context.serverDistDir;
    return server ? server.replace(/[\\/]server[\\/]?$/, "") : undefined;
  }

  key(cacheKey: string): string {
    return entryKey(this.cfg.namespace, this.#buildId(this.distDir()), cacheKey);
  }

  #failed(op: string, cacheKey: string, err: unknown): void {
    reportFailure(this.reporter, this.cfg, "legacy", op, cacheKey, err);
  }

  async get(cacheKey: string, ctx: LegacyGetContext = {}): Promise<LegacyCacheValue | null> {
    const cfg = this.cfg;
    if (cfg.isDisabled()) {
      cfg.emit({ type: "miss", handler: "legacy", key: cacheKey, reason: "disabled" });
      return null;
    }
    const requestTags = unique(ctx.tags, ctx.softTags);
    const tagKey = tagStateKey(cfg.namespace);
    const table: TagTable = new Map();
    let raw: Buffer | null;
    try {
      const key = this.key(cacheKey);
      const [value, fields] = await this.runner.run("read", (client, binary) =>
        Promise.all([
          binary.get(key) as Promise<Buffer | null>,
          requestTags.length > 0 ? (client.hmGet(tagKey, tagFields(requestTags)) as Promise<unknown[]>) : Promise.resolve([]),
        ]),
      );
      this.reporter.success();
      raw = value;
      parseTagFields(requestTags, fields, table);
    } catch (err) {
      this.#failed("get", cacheKey, err);
      return this.miss(cacheKey, ctx, isUnavailable(err) ? "unavailable" : "error");
    }
    if (!raw) return this.miss(cacheKey, ctx, "absent");

    let meta: LegacyMeta;
    let value: unknown;
    try {
      ({ meta, value } = await decodeEnvelope<LegacyMeta>(raw));
    } catch (err) {
      if (!(err instanceof EnvelopeFormatError)) throw err;
      cfg.logger.debug(`legacy get ${cacheKey}: unreadable entry (${err.message})`);
      return this.miss(cacheKey, ctx, "format");
    }

    const entryTags = meta.tags ?? [];
    const rest = missingTags(entryTags, table);
    if (rest.length > 0) {
      try {
        const fields = await this.runner.run("read", (client) => client.hmGet(tagKey, tagFields(rest)) as Promise<unknown[]>);
        parseTagFields(rest, fields, table);
      } catch (err) {
        // The entry itself was read: without its tag state it is served as it is
        this.#failed("get", cacheKey, err);
      }
    }

    const now = Date.now();
    const tags = unique(entryTags, requestTags);
    const isFetch = ctx.kind === "FETCH" || (value as { kind?: string } | null)?.kind === "FETCH";
    if (areTagsExpired(tags, table, meta.lastModified, now)) {
      if (isFetch || cfg.onTagExpired === "miss") {
        this.#renders.mark(cacheKey, now);
        cfg.emit({ type: "miss", handler: "legacy", key: cacheKey, reason: "tag" });
        return null;
      }
      return this.#stale(cacheKey, value, now);
    }
    if (areTagsStale(tags, table, meta.lastModified)) return this.#stale(cacheKey, value, now);

    // Next regenerates a time-stale entry right after this answer
    if (typeof meta.revalidate === "number" && now > meta.lastModified + meta.revalidate * 1000) this.#renders.mark(cacheKey, now);
    cfg.emit({ type: "hit", handler: "legacy", key: cacheKey });
    return { lastModified: meta.lastModified, value };
  }

  #stale(cacheKey: string, value: unknown, now: number): LegacyCacheValue {
    this.#renders.mark(cacheKey, now);
    this.cfg.emit({ type: "stale", handler: "legacy", key: cacheKey, reason: "tag" });
    return { lastModified: -1, value };
  }

  /** A Redis miss (absent, unreadable or unavailable). */
  async miss(cacheKey: string, _ctx: LegacyGetContext, reason: "absent" | "unavailable" | "error" | "format"): Promise<LegacyCacheValue | null> {
    this.#renders.mark(cacheKey, Date.now());
    this.cfg.emit({ type: "miss", handler: "legacy", key: cacheKey, reason });
    return null;
  }

  async set(cacheKey: string, data: unknown, ctx: LegacySetContext = {}): Promise<void> {
    const cfg = this.cfg;
    const now = Date.now();
    const lastModified = this.#renders.take(cacheKey, now);
    if (cfg.isDisabled()) return;
    const value = data as { kind?: string; headers?: unknown; revalidate?: number | false } | null;
    const isFetch = value?.kind === "FETCH" || ctx.fetchCache === true;
    const tags = isFetch ? unique(ctx.tags) : headerTags(value?.headers);
    const revalidate = isFetch ? value?.revalidate : (ctx.cacheControl?.revalidate ?? ctx.revalidate);
    await this.write(cacheKey, { lastModified, tags, revalidate }, data, { op: "set" });
  }

  /** Encodes and stores one entry. Never throws; returns whether Redis took it. */
  async write(cacheKey: string, meta: LegacyMeta, value: unknown, { op, onlyIfAbsent = false }: { op: string; onlyIfAbsent?: boolean }): Promise<boolean> {
    const cfg = this.cfg;
    try {
      await this.runner.available(); // fail fast, before serializing, while Redis is unavailable
      const body = await encodeEnvelope(meta, value, cfg.compression);
      const key = this.key(cacheKey);
      const ttl = ttlSeconds(cfg, meta.revalidate);
      const reply = await this.runner.run("write", (client) => client.set(key, body, setOptions(ttl, onlyIfAbsent)));
      this.reporter.success();
      if (reply !== null) cfg.emit({ type: "set", handler: "legacy", key: cacheKey, bytes: body.byteLength });
      return reply !== null;
    } catch (err) {
      this.#failed(op, cacheKey, err);
      return false;
    }
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    const list = unique(typeof tags === "string" ? [tags] : (tags ?? []));
    if (list.length === 0 || this.cfg.isDisabled()) return;
    const fields = updateFields(list, durations, Date.now());
    try {
      await this.runner.run("write", (client) => client.hSet(tagStateKey(this.cfg.namespace), fields));
      this.reporter.success();
    } catch (err) {
      this.#failed("revalidateTag", list.join(","), err);
    }
  }
}

/**
 * Creates the legacy cache handler class for `next.config` `cacheHandler`:
 *
 * ```js
 * // cache-handler.mjs
 * import { createCacheHandler } from "@mirunamu/next-redis-cache";
 * import { connectRedis } from "@mirunamu/next-redis-cache/redis";
 * export default createCacheHandler({ client: () => connectRedis(process.env.REDIS_URL), namespace: "my-app" });
 * ```
 */
export function createCacheHandler(config: RedisCacheConfig): LegacyCacheHandlerClass {
  const core = new LegacyCore(resolveConfig(config));
  return class RedisCacheHandler implements LegacyCacheHandlerInstance {
    constructor(ctx?: LegacyHandlerContext) {
      core.observe(ctx);
    }

    get(cacheKey: string, ctx?: LegacyGetContext): Promise<LegacyCacheValue | null> {
      return core.get(cacheKey, ctx);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set(cacheKey: string, data: any, ctx?: LegacySetContext): Promise<void> {
      return core.set(cacheKey, data, ctx);
    }

    revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
      return core.revalidateTag(tags, durations);
    }

    resetRequestCache(): void {
      // Nothing is cached per request
    }
  };
}
