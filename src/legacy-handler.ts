/**
 * Legacy cacheHandler (singular) implementation for ISR / Route Handler cache.
 *
 * Implements the CacheHandler class expected by Next.js `cacheHandler` config.
 * Next.js instantiates this class and calls get/set/revalidateTag on it.
 */

import type { RedisClientType } from "@redis/client";
import { parseBuffersToStrings, convertStringsToBuffers } from "./buffer-utils";
import { TagManager } from "./tag-manager";
import { assertClientReady, withTimeout } from "./redis-client";
import {
  resolveOptions,
  type LegacyHandlerConfig,
  type OnCreationHook,
} from "./types";

// ------------------------------------------------------------------
// Types aligned with next/dist/server/lib/incremental-cache
// ------------------------------------------------------------------

interface CacheHandlerContext {
  dev?: boolean;
  serverDistDir?: string;
  maxMemoryCacheSize?: number;
  revalidatedTags: string[];
  _requestHeaders: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

interface CacheHandlerValue {
  lastModified: number;
  age?: number;
  cacheState?: string;
  value: unknown;
}

interface LifespanParameters {
  lastModifiedAt: number;
  staleAt: number;
  expireAt: number;
  staleAge: number;
  expireAge: number;
  revalidate: number | false | undefined;
}

interface StoredCacheValue extends CacheHandlerValue {
  tags: readonly string[];
  lifespan: LifespanParameters | null;
}

// ------------------------------------------------------------------
// Internal state
// ------------------------------------------------------------------

const debug = typeof process.env.NEXT_PRIVATE_DEBUG_CACHE !== "undefined";
const DEFAULT_STALE_AGE = 60 * 60 * 24 * 365; // 1 year

function log(method: string, key: string, msg: string) {
  if (debug) {
    console.info("[cache-handler] [%s] [%s] %s", method, key, msg);
  }
}

function getLifespan(
  lastModified: number,
  revalidate: number | false | undefined,
  defaultStaleAge: number,
  estimateExpireAge: (s: number) => number
): LifespanParameters {
  const lastModifiedAt = Math.floor(lastModified / 1000);
  const staleAge =
    typeof revalidate === "number" ? revalidate : defaultStaleAge;
  const expireAge = Math.min(Math.floor(estimateExpireAge(staleAge)), 2 ** 31 - 1);
  return {
    lastModifiedAt,
    staleAt: lastModifiedAt + staleAge,
    expireAt: lastModifiedAt + expireAge,
    staleAge,
    expireAge,
    revalidate,
  };
}

function getTagsFromHeaders(
  headers: Record<string, unknown> | undefined
): string[] {
  if (!headers) return [];
  const v = headers["x-next-cache-tags"];
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") return v.split(",");
  return [];
}

function resolveRevalidate(
  value: unknown,
  ctx: Record<string, unknown>
): number | false | undefined {
  const v = value as Record<string, unknown> | null;
  if (v?.kind === "FETCH") return v.revalidate as number;
  if (v?.kind === "APP_PAGE" || v?.kind === "PAGES") {
    const cc = ctx.cacheControl as { revalidate?: number } | undefined;
    if (cc?.revalidate !== undefined) return cc.revalidate;
  }
  return ctx.revalidate as number | false | undefined;
}

// ------------------------------------------------------------------
// CacheHandler class
// ------------------------------------------------------------------

export class LegacyCacheHandler {
  // Static configuration
  static #onCreationHook: OnCreationHook | undefined;
  static #context: CacheHandlerContext | undefined;
  static #configTask: Promise<void> | undefined;

  // Initialized state
  static #client: RedisClientType | undefined;
  static #tagManager: TagManager | undefined;
  static #keyPrefix = "";
  static #timeoutMs = 5000;
  static #defaultStaleAge = DEFAULT_STALE_AGE;
  static #estimateExpireAge: (s: number) => number = (s) =>
    Math.floor(s * 1.5);
  static #configured = false;

  /**
   * Register setup hook (called from consumer's cache-handler.mjs at module scope).
   */
  static onCreation(hook: OnCreationHook): void {
    LegacyCacheHandler.#onCreationHook = hook;
  }

  static async #ensureConfigured(): Promise<void> {
    if (LegacyCacheHandler.#configured) return;

    if (!LegacyCacheHandler.#configTask) {
      LegacyCacheHandler.#configTask = (async () => {
        try {
          await LegacyCacheHandler.#init();
        } finally {
          LegacyCacheHandler.#configTask = undefined;
        }
      })();
    }

    await LegacyCacheHandler.#configTask;
  }

  static async #init(): Promise<void> {
    if (LegacyCacheHandler.#configured) return;

    const hook = LegacyCacheHandler.#onCreationHook;
    if (!hook) {
      throw new Error("[cache-handler] onCreation hook not registered");
    }

    const ctx = LegacyCacheHandler.#context;
    const config = await hook({
      serverDistDir: ctx?.serverDistDir,
      dev: ctx?.dev,
    });

    if (!config) {
      // null config = build phase, no Redis
      LegacyCacheHandler.#configured = true;
      return;
    }

    const opts = resolveOptions(config);
    LegacyCacheHandler.#client = opts.client;
    LegacyCacheHandler.#tagManager = new TagManager(opts);
    LegacyCacheHandler.#keyPrefix = opts.keyPrefix;
    LegacyCacheHandler.#timeoutMs = opts.timeoutMs;

    if (config.defaultStaleAge !== undefined) {
      LegacyCacheHandler.#defaultStaleAge = config.defaultStaleAge;
    }
    if (config.estimateExpireAge) {
      LegacyCacheHandler.#estimateExpireAge = config.estimateExpireAge;
    }

    LegacyCacheHandler.#configured = true;
    log("init", "-", "configured successfully");
  }

  // ------------------------------------------------------------------
  // Instance
  // ------------------------------------------------------------------

  constructor(context: CacheHandlerContext) {
    LegacyCacheHandler.#context = context;
    log("constructor", "-", "instance created");
  }

  async get(
    cacheKey: string,
    _ctx?: Record<string, unknown>
  ): Promise<CacheHandlerValue | null> {
    await LegacyCacheHandler.#ensureConfigured();

    const client = LegacyCacheHandler.#client;
    const tm = LegacyCacheHandler.#tagManager;

    // No Redis (build phase or null config)
    if (!client || !tm) return null;

    try {
      assertClientReady(client);

      const raw = await withTimeout(
        client.get(LegacyCacheHandler.#keyPrefix + cacheKey),
        LegacyCacheHandler.#timeoutMs
      );

      if (!raw) {
        log("get", cacheKey, "miss");
        return null;
      }

      const stored: StoredCacheValue = JSON.parse(raw);
      if (!stored) return null;

      // Restore buffers
      if (stored.value) {
        convertStringsToBuffers(stored.value);
      }

      // Check tag entry exists
      const hasEntry = await tm.hasTagEntry(cacheKey);
      if (!hasEntry) {
        await withTimeout(
          client.unlink(LegacyCacheHandler.#keyPrefix + cacheKey),
          LegacyCacheHandler.#timeoutMs
        );
        log("get", cacheKey, "orphaned (no tag entry)");
        return null;
      }

      // Check lifespan expiry
      if (stored.lifespan && stored.lifespan.expireAt < Math.floor(Date.now() / 1000)) {
        log("get", cacheKey, "expired");
        return null;
      }

      // Check tag revalidation
      const softTags =
        (_ctx as Record<string, unknown>)?.softTags as string[] | undefined;
      const combinedTags = [
        ...(stored.tags ?? []),
        ...(softTags ?? []),
      ];

      if (await tm.isStale(combinedTags, stored.lastModified)) {
        await withTimeout(
          client.unlink(LegacyCacheHandler.#keyPrefix + cacheKey),
          LegacyCacheHandler.#timeoutMs
        );
        log("get", cacheKey, "stale (revalidated tag)");
        return null;
      }

      log("get", cacheKey, "hit");
      return stored;
    } catch (err) {
      log("get", cacheKey, `error: ${err}`);
      return null;
    }
  }

  async set(
    cacheKey: string,
    data: unknown,
    ctx?: Record<string, unknown>
  ): Promise<void> {
    await LegacyCacheHandler.#ensureConfigured();

    const client = LegacyCacheHandler.#client;
    const tm = LegacyCacheHandler.#tagManager;
    if (!client || !tm) return;

    try {
      assertClientReady(client);

      const tags: string[] =
        (ctx?.tags as string[]) ??
        getTagsFromHeaders(
          (data as Record<string, unknown>)?.headers as
            | Record<string, unknown>
            | undefined
        );

      const revalidate = resolveRevalidate(data, ctx ?? {});
      const lastModified = Math.round(
        (ctx?.internal_lastModified as number) ?? Date.now()
      );

      const lifespan = getLifespan(
        lastModified,
        revalidate,
        LegacyCacheHandler.#defaultStaleAge,
        LegacyCacheHandler.#estimateExpireAge
      );

      // Skip if already expired
      if (Date.now() > lifespan.expireAt * 1000) return;

      // Serialize buffers
      const valueForStorage = data ? { ...(data as object) } : null;
      if (valueForStorage) {
        parseBuffersToStrings(valueForStorage);
      }

      const stored: StoredCacheValue = {
        lastModified,
        value: valueForStorage,
        tags: Object.freeze(tags),
        lifespan,
      };

      const serialized = JSON.stringify(stored);
      const fullKey = LegacyCacheHandler.#keyPrefix + cacheKey;
      const t = LegacyCacheHandler.#timeoutMs;

      const isNX = (ctx as Record<string, unknown>)?.setOnlyIfNotExists === true;

      const ttlSeconds = Math.max(
        1,
        lifespan.expireAt - Math.floor(Date.now() / 1000)
      );
      const setOpts: Record<string, unknown> = { EX: ttlSeconds };
      if (isNX) setOpts.NX = true;

      await Promise.all([
        // Store value with TTL in a single command
        withTimeout(client.set(fullKey, serialized, setOpts), t),
        // Register tags
        tm.setTags(cacheKey, tags),
        // Register TTL
        tm.setTtl(cacheKey, lifespan.expireAt),
      ]);

      log("set", cacheKey, "stored");
    } catch (err) {
      log("set", cacheKey, `error: ${err}`);
    }
  }

  async revalidateTag(
    tag: string | string[],
    _durations?: { expire?: number }
  ): Promise<void> {
    await LegacyCacheHandler.#ensureConfigured();

    const tm = LegacyCacheHandler.#tagManager;
    if (!tm) return;

    const tags = typeof tag === "string" ? [tag] : tag;

    for (const t of tags) {
      try {
        await tm.revalidateTag(t);
        log("revalidateTag", t, "done");
      } catch (err) {
        log("revalidateTag", t, `error: ${err}`);
      }
    }
  }

  resetRequestCache(): void {
    // No-op for Redis-based handler
  }
}
