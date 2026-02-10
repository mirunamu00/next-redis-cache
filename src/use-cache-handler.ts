/**
 * New cacheHandlers (plural) implementation for `use cache` directive.
 *
 * Implements the CacheHandler interface from next/dist/server/lib/cache-handlers/types.
 * Stores ReadableStream<Uint8Array> entries in Redis as base64 + metadata.
 */

import type { RedisClientType } from "@redis/client";
import { streamToBuffer, bufferToStream } from "./stream-utils";
import { TagManager } from "./tag-manager";
import { assertClientReady, withTimeout } from "./redis-client";
import { resolveOptions, type UseCacheHandlerOptions } from "./types";

// ------------------------------------------------------------------
// Types aligned with next/dist/server/lib/cache-handlers/types
// ------------------------------------------------------------------

interface CacheEntry {
  value: ReadableStream<Uint8Array>;
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

interface CacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined>;
  set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<number>;
  updateTags(
    tags: string[],
    durations?: { expire?: number }
  ): Promise<void>;
}

// ------------------------------------------------------------------
// Serialized form stored in Redis
// ------------------------------------------------------------------

interface StoredEntry {
  /** base64-encoded stream data */
  data: string;
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

// ------------------------------------------------------------------
// Factory
// ------------------------------------------------------------------

const debug = typeof process.env.NEXT_PRIVATE_DEBUG_CACHE !== "undefined";

function log(method: string, key: string, msg: string) {
  if (debug) {
    console.info("[use-cache-handler] [%s] [%s] %s", method, key, msg);
  }
}

export function createUseCacheHandler(
  opts: UseCacheHandlerOptions
): CacheHandler {
  const resolved = resolveOptions(opts);
  const client = resolved.client;
  const keyPrefix = opts.useCacheKeyPrefix ?? `uc:${resolved.keyPrefix}`;
  const timeoutMs = resolved.timeoutMs;
  const tagManager = new TagManager(resolved);

  // Track pending set operations so concurrent gets can wait
  const pendingSets = new Map<string, Promise<void>>();

  function exec<T>(promise: Promise<T>): Promise<T> {
    assertClientReady(client);
    return withTimeout(promise, timeoutMs);
  }

  const handler: CacheHandler = {
    async get(
      cacheKey: string,
      softTags: string[]
    ): Promise<CacheEntry | undefined> {
      try {
        // Wait for pending set on same key
        const pending = pendingSets.get(cacheKey);
        if (pending) {
          log("get", cacheKey, "waiting for pending set");
          await pending;
        }

        const raw = await exec(client.get(keyPrefix + cacheKey));

        if (!raw) {
          log("get", cacheKey, "miss");
          return undefined;
        }

        const stored: StoredEntry = JSON.parse(raw);

        // Check expiration (revalidate-based, same logic as Next.js default handler)
        const now = performance.timeOrigin + performance.now();
        if (now > stored.timestamp + stored.revalidate * 1000) {
          log("get", cacheKey, "expired (revalidate)");
          return undefined;
        }

        // Check soft tags staleness
        if (softTags.length > 0) {
          const expiration = await tagManager.getTagExpiration(softTags);
          if (expiration > 0 && expiration > stored.timestamp) {
            log("get", cacheKey, "stale (soft tag)");
            return undefined;
          }
        }

        // Check entry tags staleness
        if (stored.tags.length > 0) {
          const expiration = await tagManager.getTagExpiration(stored.tags);
          if (expiration > 0 && expiration > stored.timestamp) {
            log("get", cacheKey, "stale (entry tag)");
            return undefined;
          }
        }

        // Restore stream from base64
        const buffer = Buffer.from(stored.data, "base64");
        const value = bufferToStream(buffer);

        log("get", cacheKey, "hit");

        return {
          value,
          tags: stored.tags,
          stale: stored.stale,
          timestamp: stored.timestamp,
          expire: stored.expire,
          revalidate: stored.revalidate,
        };
      } catch (err) {
        log("get", cacheKey, `error: ${err}`);
        return undefined;
      }
    },

    async set(
      cacheKey: string,
      pendingEntry: Promise<CacheEntry>
    ): Promise<void> {
      log("set", cacheKey, "start");

      let resolvePending: () => void = () => {};
      const pendingPromise = new Promise<void>((resolve) => {
        resolvePending = resolve;
      });
      pendingSets.set(cacheKey, pendingPromise);

      try {
        const entry = await pendingEntry;

        // Tee the stream: one for consumption, one preserved on entry
        const [forStorage, preserved] = entry.value.tee();
        entry.value = preserved;

        // Consume the stream to buffer
        const buffer = await streamToBuffer(forStorage);
        const data = buffer.toString("base64");

        const stored: StoredEntry = {
          data,
          tags: entry.tags,
          stale: entry.stale,
          timestamp: entry.timestamp,
          expire: entry.expire,
          revalidate: entry.revalidate,
        };

        const serialized = JSON.stringify(stored);
        const fullKey = keyPrefix + cacheKey;

        // Calculate TTL in seconds from now
        const ttlSeconds = Math.max(
          1,
          Math.floor(entry.expire - (Date.now() - entry.timestamp) / 1000)
        );

        await exec(client.set(fullKey, serialized, { EX: ttlSeconds }));

        log("set", cacheKey, `done (${buffer.byteLength} bytes)`);
      } catch (err) {
        log("set", cacheKey, `error: ${err}`);
      } finally {
        resolvePending();
        pendingSets.delete(cacheKey);
      }
    },

    async refreshTags(): Promise<void> {
      // For distributed Redis, tags are already shared via Redis Hash.
      // No additional sync needed — all instances read from the same source.
      log("refreshTags", "-", "no-op (Redis is shared)");
    },

    async getExpiration(tags: string[]): Promise<number> {
      try {
        return await tagManager.getTagExpiration(tags);
      } catch (err) {
        log("getExpiration", "-", `error: ${err}`);
        return 0;
      }
    },

    async updateTags(
      tags: string[],
      durations?: { expire?: number }
    ): Promise<void> {
      try {
        await tagManager.updateTagTimestamps(tags, durations);
        log("updateTags", tags.join(","), "done");
      } catch (err) {
        log("updateTags", tags.join(","), `error: ${err}`);
      }
    },
  };

  return handler;
}
