/**
 * "use cache" handler (`next.config` `cacheHandlers`), Next.js 16 CacheHandler interface.
 *
 * get(key, softTags)
 *   GET entry + HMGET of the implicit (soft) tags in one round trip, HMGET of the entry's own tags
 *   when needed (second round trip). Semantics of Next's default handler and use-cache wrapper
 *   (ROADMAP.md 5.2):
 *     expire < 0 (eviction mark) or past expire             -> miss
 *     past revalidate                                       -> returned as is: Next serves it and
 *                                                              regenerates in the background (swr);
 *                                                              a miss with swr: false
 *     implicit tag expired at/after the entry was created   -> miss (the wrapper's getExpiration rule)
 *     own tag expired (areTagsExpired)                      -> miss
 *     own tag stale (areTagsStale)                          -> revalidate: -1 (served stale, regenerated)
 * getExpiration() returns Infinity: implicit tags are checked in get, in the same round trip.
 * updateTags(tags, durations)  one HSET of the shared tag state (the same state the legacy handler uses).
 * set  one SET with EX = the entry's remaining lifetime; the value stream is stored as raw bytes.
 */
import { buildIdResolver, resolveConfig } from "./config";
import { decodeEnvelope, encodeEnvelope, EnvelopeFormatError } from "./envelope";
import { tagStateKey, useCacheKey } from "./keys";
import { FailureReporter, reportFailure } from "./logger";
import { isUnavailable, Runner } from "./runner";
import { bufferToStream, streamToBuffer } from "./stream-utils";
import {
  areTagsExpired,
  areTagsStale,
  missingTags,
  parseTagFields,
  softTagsDiscard,
  tagFields,
  TagStateCache,
  type TagTable,
} from "./tag-state";
import { TagStateWriter } from "./tag-writer";
import { setOptions } from "./ttl";
import type { CacheEvent, UseCacheConfig, UseCacheEntry, UseCacheHandler } from "./types";

/** Metadata stored next to the value bytes. */
export interface UseCacheMeta {
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

function unique(list: readonly string[] | undefined): string[] {
  return [...new Set((list ?? []).filter(Boolean))];
}

/**
 * Creates the handler for `next.config` `cacheHandlers.default` / `.remote`:
 *
 * ```js
 * // use-cache-handler.mjs
 * import { createUseCacheHandler } from "@mirunamu/next-redis-cache/use-cache";
 * import { connectRedis } from "@mirunamu/next-redis-cache/redis";
 * export default createUseCacheHandler({ client: () => connectRedis(process.env.REDIS_URL), namespace: "my-app" });
 * ```
 */
export function createUseCacheHandler(config: UseCacheConfig): UseCacheHandler {
  const cfg = resolveConfig(config);
  const swr = config.swr ?? true;
  const tagCacheMs = config.tagStateCacheMs ?? 0;
  if (typeof tagCacheMs !== "number" || !Number.isFinite(tagCacheMs) || tagCacheMs < 0) {
    throw new TypeError(`[next-redis-cache] tagStateCacheMs must be a number >= 0, got ${String(tagCacheMs)}`);
  }
  const tagCache = new TagStateCache(tagCacheMs);
  const runner = new Runner(cfg);
  const reporter = new FailureReporter("use-cache", cfg.logger);
  const tagWriter = new TagStateWriter(runner, cfg);
  const buildId = buildIdResolver(cfg);
  const tagKey = tagStateKey(cfg.namespace);
  const keyOf = (cacheKey: string) => useCacheKey(cfg.namespace, buildId(), cacheKey);
  /** Latest set per key; a get waits for it (7-12: an older set never clears a newer marker). */
  const pending = new Map<string, { token: symbol; done: Promise<void> }>();

  const miss = (key: string, reason: Extract<CacheEvent, { type: "miss" }>["reason"]) => {
    cfg.emit({ type: "miss", handler: "use-cache", key, reason });
    return undefined;
  };
  const failed = (op: string, key: string, err: unknown) => reportFailure(reporter, cfg, "use-cache", op, key, err);

  /** Reads `tags` into `table` (cache first, then one HMGET). */
  async function readTags(tags: readonly string[], table: TagTable): Promise<void> {
    const rest = tagCache.lookup(tags, table, Date.now());
    if (rest.length === 0) return;
    const fields = await runner.run("read", (client) => client.hmGet(tagKey, tagFields(rest)) as Promise<unknown[]>);
    parseTagFields(rest, fields, table);
    tagCache.store(table, rest, Date.now());
  }

  return {
    async get(cacheKey, softTags) {
      const waiting = pending.get(cacheKey);
      if (waiting) await waiting.done;
      if (cfg.isDisabled()) return miss(cacheKey, "disabled");

      const soft = unique(softTags);
      const table: TagTable = new Map();
      let raw: Buffer | null;
      try {
        const key = keyOf(cacheKey);
        const softRest = tagCache.lookup(soft, table, Date.now());
        const [value, fields] = await runner.run("read", (client, binary) =>
          Promise.all([
            binary.get(key) as Promise<Buffer | null>,
            softRest.length > 0 ? (client.hmGet(tagKey, tagFields(softRest)) as Promise<unknown[]>) : Promise.resolve([]),
          ]),
        );
        reporter.success();
        raw = value;
        parseTagFields(softRest, fields, table);
        tagCache.store(table, softRest, Date.now());
      } catch (err) {
        failed("get", cacheKey, err);
        return miss(cacheKey, isUnavailable(err) ? "unavailable" : "error");
      }
      if (!raw) return miss(cacheKey, "absent");

      let meta: UseCacheMeta;
      let value: unknown;
      try {
        ({ meta, value } = await decodeEnvelope<UseCacheMeta>(raw));
      } catch (err) {
        if (!(err instanceof EnvelopeFormatError)) throw err;
        cfg.logger.debug(`use-cache get ${cacheKey}: unreadable entry (${err.message})`);
        return miss(cacheKey, "format");
      }
      if (!Buffer.isBuffer(value)) return miss(cacheKey, "format");

      const now = Date.now();
      if (meta.expire < 0 || now > meta.timestamp + meta.expire * 1000) return miss(cacheKey, "expired");
      if (!swr && now > meta.timestamp + meta.revalidate * 1000) return miss(cacheKey, "expired");
      if (softTagsDiscard(soft, table, meta.timestamp)) return miss(cacheKey, "tag");

      const tags = unique(meta.tags);
      const rest = missingTags(tags, table);
      if (rest.length > 0) {
        try {
          await readTags(rest, table);
        } catch (err) {
          // The entry itself was read: without its tag state it is served as it is
          failed("get", cacheKey, err);
        }
      }
      if (areTagsExpired(tags, table, meta.timestamp, now)) return miss(cacheKey, "tag");
      let revalidate = meta.revalidate;
      if (areTagsStale(tags, table, meta.timestamp)) {
        revalidate = -1;
        cfg.emit({ type: "stale", handler: "use-cache", key: cacheKey, reason: "tag" });
      } else {
        cfg.emit({ type: "hit", handler: "use-cache", key: cacheKey });
      }
      return {
        value: bufferToStream(value),
        tags: meta.tags,
        stale: meta.stale,
        timestamp: meta.timestamp,
        expire: meta.expire,
        revalidate,
      };
    },

    async set(cacheKey, pendingEntry) {
      const token = Symbol(cacheKey);
      let release!: () => void;
      const done = new Promise<void>((resolve) => (release = resolve));
      pending.set(cacheKey, { token, done });
      let entry: UseCacheEntry;
      try {
        entry = await pendingEntry;
      } catch {
        // A failed render: nothing to store, and not a Redis failure
        finish();
        return;
      }
      try {
        if (cfg.isDisabled()) return;
        const key = keyOf(cacheKey);
        if (entry.expire < 0) {
          // Eviction mark (Next 16.3): drop the stored entry
          await runner.run("write", (client) => client.unlink(key));
          reporter.success();
          return;
        }
        await runner.available(); // fail fast, before reading the stream, while Redis is unavailable
        const bytes = await streamToBuffer(entry.value);
        const lifetimeSeconds = swr ? entry.expire : Math.min(entry.expire, entry.revalidate);
        const remainingMs = lifetimeSeconds * 1000 - (Date.now() - entry.timestamp);
        if (!(remainingMs > 0)) return; // already expired: nothing worth storing
        // One second beyond the lifetime: at exactly timestamp + lifetime the entry is still valid for Next,
        // so the key must not be gone yet (get() applies the exact boundary itself)
        const ttl = Math.max(1, Math.min(Math.ceil(remainingMs / 1000) + 1, Math.floor(cfg.maxSeconds)));
        const meta: UseCacheMeta = {
          tags: entry.tags ?? [],
          stale: entry.stale,
          timestamp: entry.timestamp,
          expire: entry.expire,
          revalidate: entry.revalidate,
        };
        const body = await encodeEnvelope(meta, bytes, cfg.compression);
        await runner.run("write", (client) => client.set(key, body, setOptions(ttl)));
        reporter.success();
        cfg.emit({ type: "set", handler: "use-cache", key: cacheKey, bytes: body.byteLength });
      } catch (err) {
        failed("set", cacheKey, err);
      } finally {
        finish();
      }

      function finish() {
        if (pending.get(cacheKey)?.token === token) pending.delete(cacheKey);
        release();
      }
    },

    async refreshTags() {
      // Tag state lives in Redis and is read with every get (tagStateCacheMs bounds any local copy)
    },

    async getExpiration() {
      // Implicit tags are checked in get(), in the same round trip as the entry
      return Infinity;
    },

    async updateTags(tags, durations) {
      const list = unique(tags);
      if (list.length === 0 || cfg.isDisabled()) return;
      try {
        await tagWriter.write(list, durations);
        reporter.success();
      } catch (err) {
        failed("updateTags", list.join(","), err);
      } finally {
        tagCache.invalidate(list);
      }
    },
  };
}
