/**
 * Instrumentation helpers for Next.js cache handler.
 *
 * - registerInitialCache: Pre-warm Redis from build output via CacheHandler.set()
 * - cleanupOldBuildKeys: Delete Redis keys from previous builds
 */

import { promises as fs } from "fs";
import path from "path";
import { createClient } from "@redis/client";
import { withTimeout } from "./redis-client";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface RegisterInitialCacheOptions {
  /** Skip keys that already exist in Redis (default: true) */
  setOnlyIfNotExists?: boolean;
}

export interface CleanupPattern {
  /** Redis KEYS pattern to scan (e.g. "myapp:*") */
  scan: string;
  /** Keep this exact key (e.g. "myappTags:abc123") */
  keepExact?: string;
  /** Keep keys starting with this prefix (e.g. "myapp:abc123:") */
  keepPrefix?: string;
}

export interface CleanupOptions {
  /** Redis connection URL */
  redisUrl: string;
  /** Patterns defining which keys to scan and which to keep */
  patterns: CleanupPattern[];
  /**
   * Give up when Redis is not reachable within this time, and when a single SCAN/UNLINK takes
   * longer (ms, default 5000). The cleanup then logs a warning and resolves instead of hanging.
   */
  timeoutMs?: number;
}

/** Keys per UNLINK command: bounded work per round trip instead of one huge DEL (7-9). */
const UNLINK_BATCH_SIZE = 500;
const SCAN_COUNT = 200;

interface PrerenderManifest {
  version: number;
  routes: Record<
    string,
    {
      initialRevalidateSeconds: number | false;
      srcRoute: string | null;
      dataRoute: string | null;
    }
  >;
}

interface MetaFile {
  status?: number;
  headers?: Record<string, string>;
  segmentPaths?: string[];
  postponed?: string;
}

// ------------------------------------------------------------------
// Disk reading helpers
//
// Mirrors how Next's FileSystemCache reads prerendered output (next/dist/server/lib/incremental-cache/
// file-system-cache.js), so a prewarmed entry is the same entry Next would have produced:
//   APP_PAGE   <key>.html + <key>.meta (status, headers, postponed, segmentPaths) + <key>.rsc (unless
//              postponed) + <key>.segments<segmentPath>.segment.rsc for every meta segmentPath
//   APP_ROUTE  <key>.body + <key>.meta (status, headers)
// ------------------------------------------------------------------

/** Next's cache key for a prerendered route: the root page is stored as "/index". */
function cacheKeyOf(route: string): string {
  return route === "/" ? "/index" : route;
}

async function readFileOrNull(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

async function readRouteFromDisk(
  appDir: string,
  cacheKey: string
): Promise<Record<string, unknown> | null> {
  const basePath = path.join(appDir, cacheKey);

  const html = await readFileOrNull(basePath + ".html");
  if (html) {
    const meta = await readMeta(basePath + ".meta");
    const postponed = meta?.postponed;
    // Like Next: a partially prerendered page (postponed state) is served without the full RSC payload
    const rscData =
      postponed == null ? await readFileOrNull(basePath + ".rsc") : undefined;
    if (postponed == null && !rscData) return null;

    return {
      kind: "APP_PAGE",
      html: html.toString("utf-8"),
      rscData: rscData ?? undefined,
      headers: meta?.headers,
      postponed,
      status: meta?.status,
      segmentData: await readSegmentData(basePath + ".segments", meta?.segmentPaths),
    };
  }

  const body = await readFileOrNull(basePath + ".body");
  if (body) {
    const meta = await readMeta(basePath + ".meta");
    return {
      kind: "APP_ROUTE",
      body,
      status: meta?.status ?? 200,
      headers: meta?.headers ?? {},
    };
  }

  return null;
}

/**
 * Segment prefetch data keyed exactly like Next's cache entries: by the meta's segmentPaths
 * ("/_tree", "/about/__PAGE__"). Pages without segmentPaths have no segment data.
 */
async function readSegmentData(
  segmentsDir: string,
  segmentPaths: string[] | undefined
): Promise<Map<string, Buffer> | undefined> {
  if (!segmentPaths) return undefined;
  const map = new Map<string, Buffer>();
  for (const segmentPath of segmentPaths) {
    const data = await readFileOrNull(segmentsDir + segmentPath + ".segment.rsc");
    // A missing segment file is treated like Next does: that segment has no prefetch data
    if (data) map.set(segmentPath, data);
  }
  return map;
}

async function readMeta(metaPath: string): Promise<MetaFile | null> {
  try {
    return JSON.parse(await fs.readFile(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Pre-warm the cache by reading build output and populating Redis
 * via the CacheHandler's own set() method.
 *
 * Usage in consumer's instrumentation.ts:
 * ```ts
 * const { registerInitialCache } = await import("@mirunamu/next-redis-cache/instrumentation");
 * const CacheHandler = (await import("./cache-handler.mjs")).default;
 * await registerInitialCache(CacheHandler, { setOnlyIfNotExists: true });
 * ```
 */
export async function registerInitialCache(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CacheHandlerClass: new (context: any) => {
    set(
      key: string,
      data: unknown,
      ctx: Record<string, unknown>
    ): Promise<void>;
  },
  options: RegisterInitialCacheOptions = {}
): Promise<{ prewarmed: number }> {
  const serverDistDir = path.join(process.cwd(), ".next", "server");
  const manifestPath = path.join(
    process.cwd(),
    ".next",
    "prerender-manifest.json"
  );

  let manifest: PrerenderManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  } catch {
    console.log("[cache-prewarm] No prerender manifest found, skipping");
    return { prewarmed: 0 };
  }

  if (manifest.version !== 4) {
    console.warn(
      `[cache-prewarm] Unexpected manifest version: ${manifest.version}`
    );
    return { prewarmed: 0 };
  }

  const handler = new CacheHandlerClass({ serverDistDir });
  const appDir = path.join(serverDistDir, "app");
  let prewarmed = 0;

  // Every prerendered App Router output: pages (including "/" as "/index" and "/_not-found") and
  // route handlers (dataRoute null, e.g. /icon). Routes without App Router output on disk (Pages
  // Router) are skipped.
  for (const [route, routeInfo] of Object.entries(manifest.routes)) {
    const cacheKey = cacheKeyOf(route);
    try {
      const value = await readRouteFromDisk(appDir, cacheKey);
      if (!value) continue;

      await handler.set(cacheKey, value, {
        revalidate: routeInfo.initialRevalidateSeconds,
        setOnlyIfNotExists: options.setOnlyIfNotExists ?? true,
      });

      prewarmed++;
    } catch (err) {
      console.warn(`[cache-prewarm] Failed for ${route}: ${err}`);
    }
  }

  console.log(`[cache-prewarm] Done. Prewarmed: ${prewarmed}`);
  return { prewarmed };
}

/**
 * Cleanup Redis keys from old builds.
 *
 * Keys are found with SCAN (COUNT 200) and removed with UNLINK in batches of at most
 * 500 while scanning, so memory stays bounded and no single command blocks Redis for long.
 * Keys matched by several patterns are deleted and counted once (`deleted` is what Redis removed).
 *
 * The cleanup never hangs startup and never rejects because of Redis: an unreachable Redis (connect
 * timeout, no reconnect attempts) or a failing command is logged with console.warn and the promise
 * resolves with the keys deleted so far.
 *
 * Usage in consumer's instrumentation.ts:
 * ```ts
 * const { cleanupOldBuildKeys } = await import("@mirunamu/next-redis-cache/instrumentation");
 * await cleanupOldBuildKeys({
 *   redisUrl: process.env.REDIS_URL,
 *   patterns: [
 *     { scan: "myapp:*", keepPrefix: `myapp:${buildId}:` },
 *     { scan: "myappTags:*", keepExact: `myappTags:${buildId}` },
 *   ],
 * });
 * ```
 */
export async function cleanupOldBuildKeys(
  options: CleanupOptions
): Promise<{ deleted: number }> {
  const { redisUrl, patterns, timeoutMs = 5000 } = options;
  const client = createClient({
    url: redisUrl,
    socket: { connectTimeout: timeoutMs, reconnectStrategy: false },
  });
  client.on("error", (err: Error) =>
    console.warn("[cache-cleanup:redis]", err.message)
  );

  let deleted = 0;
  let batch = new Set<string>();
  const flush = async () => {
    if (batch.size === 0) return;
    const keys = [...batch];
    batch = new Set();
    deleted += Number(await withTimeout(client.unlink(keys), timeoutMs));
  };

  try {
    await withTimeout(client.connect(), timeoutMs);

    for (const { scan, keepExact, keepPrefix } of patterns) {
      let cursor = "0";
      do {
        const reply = await withTimeout(
          client.scan(cursor, { MATCH: scan, COUNT: SCAN_COUNT }),
          timeoutMs
        );
        cursor = String(reply.cursor);
        for (const key of reply.keys) {
          const k = String(key);
          if (keepExact && k === keepExact) continue;
          if (keepPrefix && k.startsWith(keepPrefix)) continue;
          batch.add(k);
          if (batch.size >= UNLINK_BATCH_SIZE) await flush();
        }
      } while (cursor !== "0");
    }
    await flush();

    console.log(`[cache-cleanup] Done. Deleted ${deleted} old keys.`);
  } catch (err) {
    console.warn(
      `[cache-cleanup] Gave up after deleting ${deleted} keys: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    try {
      client.destroy();
    } catch {
      // never connected
    }
  }
  return { deleted };
}
