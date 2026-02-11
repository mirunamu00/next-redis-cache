/**
 * Instrumentation helpers for Next.js cache handler.
 *
 * - registerInitialCache: Pre-warm Redis from build output via CacheHandler.set()
 * - cleanupOldBuildKeys: Delete Redis keys from previous builds
 */

import { promises as fs } from "fs";
import path from "path";
import { createClient } from "@redis/client";

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
}

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
  headers?: Record<string, string>;
  segmentPaths?: string[];
}

// ------------------------------------------------------------------
// Disk reading helpers
// ------------------------------------------------------------------

async function readRouteFromDisk(
  appDir: string,
  route: string,
  routeInfo: PrerenderManifest["routes"][string]
): Promise<Record<string, unknown> | null> {
  const basePath = path.join(appDir, route);
  const isAppRoute = routeInfo.dataRoute === null;
  const isRscRoute = routeInfo.dataRoute?.endsWith(".rsc");

  if (isRscRoute) {
    const htmlPath = basePath + ".html";
    const rscPath = basePath + ".rsc";
    const [htmlExists, rscExists] = await Promise.all([
      fs.stat(htmlPath).catch(() => null),
      fs.stat(rscPath).catch(() => null),
    ]);
    if (!htmlExists || !rscExists) return null;

    const [html, rscData, segmentData] = await Promise.all([
      fs.readFile(htmlPath, "utf-8"),
      fs.readFile(rscPath),
      readSegmentData(basePath + ".segments"),
    ]);
    const meta = await readMeta(basePath + ".meta");

    return {
      kind: "APP_PAGE",
      html,
      rscData,
      headers: meta?.headers,
      postponed: undefined,
      status: undefined,
      segmentData,
    };
  }

  if (isAppRoute) {
    const bodyPath = basePath + ".body";
    const bodyExists = await fs.stat(bodyPath).catch(() => null);
    if (!bodyExists) return null;

    const body = await fs.readFile(bodyPath);
    const meta = await readMeta(basePath + ".meta");

    return {
      kind: "APP_ROUTE",
      body,
      status: 200,
      headers: meta?.headers ?? {},
    };
  }

  return null;
}

async function readSegmentData(
  segmentsDir: string
): Promise<Map<string, Buffer> | undefined> {
  try {
    const entries = await fs.readdir(segmentsDir, { withFileTypes: true });
    const segmentFiles = entries.filter(
      (e) => e.isFile() && e.name.endsWith(".segment.rsc")
    );
    if (segmentFiles.length === 0) return undefined;

    const map = new Map<string, Buffer>();
    for (const file of segmentFiles) {
      const data = await fs.readFile(path.join(segmentsDir, file.name));
      const key = file.name.replace(/\.segment\.rsc$/, "");
      map.set(key, data);
    }

    const dirs = entries.filter((e) => e.isDirectory());
    for (const dir of dirs) {
      const sub = await readSegmentData(path.join(segmentsDir, dir.name));
      if (sub) {
        for (const [key, val] of sub) {
          map.set(`${dir.name}/${key}`, val);
        }
      }
    }

    return map.size > 0 ? map : undefined;
  } catch {
    return undefined;
  }
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

  for (const [route, routeInfo] of Object.entries(manifest.routes)) {
    if (route.startsWith("/_")) continue;
    if (!routeInfo.dataRoute) continue;

    try {
      const value = await readRouteFromDisk(appDir, route, routeInfo);
      if (!value) continue;

      await handler.set(route, value, {
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
  const { redisUrl, patterns } = options;
  const client = createClient({ url: redisUrl });
  client.on("error", (err) =>
    console.error("[cache-cleanup:redis]", err.message)
  );
  await client.connect();

  try {
    const allOldKeys: string[] = [];

    for (const { scan, keepExact, keepPrefix } of patterns) {
      for await (const keys of client.scanIterator({
        MATCH: scan,
        COUNT: 200,
      })) {
        for (const key of keys) {
          const k = String(key);
          if (keepExact && k === keepExact) continue;
          if (keepPrefix && k.startsWith(keepPrefix)) continue;
          allOldKeys.push(k);
        }
      }
    }

    if (allOldKeys.length > 0) {
      console.log(`[cache-cleanup] Deleting ${allOldKeys.length} old keys`);
      await client.del(allOldKeys);
    }

    console.log(`[cache-cleanup] Done.`);
    return { deleted: allOldKeys.length };
  } finally {
    await client.disconnect();
  }
}
