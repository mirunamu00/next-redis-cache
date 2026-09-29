/**
 * Read-only access to the Next.js build output (ROADMAP.md section 5.4).
 *
 * A custom `cacheHandler` replaces Next's file-system cache entirely: without Redis (absent, flushed,
 * evicted, down) a prerendered page is a cache miss, and a `dynamicParams = false` route answers 404.
 * This module reads prerendered pages (APP_PAGE) and route handlers (APP_ROUTE) from
 * `.next/server/app` with Next's own FileSystemCache - read only (flushToDisk false, no memory cache) -
 * so the html/rsc/meta/segment layout is always interpreted by the Next version that wrote it.
 * The internal module path is guarded: if it cannot be loaded, the fallback is off (warned once), and
 * matrix contract tests cover every supported Next version.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { ResolvedLogger } from "./logger";

const FILE_SYSTEM_CACHE = "next/dist/server/lib/incremental-cache/file-system-cache.js";

export const BUILD_OUTPUT_KINDS = new Set(["APP_PAGE", "APP_ROUTE"]);

export interface BuildOutputEntry {
  lastModified: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
}

interface FileSystemCacheInstance {
  get(key: string, ctx: { kind: string; isRoutePPREnabled?: boolean; isFallback?: boolean }): Promise<BuildOutputEntry | null>;
}

type FileSystemCacheClass = new (ctx: Record<string, unknown>) => FileSystemCacheInstance;

export interface PrerenderRoute {
  initialRevalidateSeconds?: number | false;
  srcRoute?: string | null;
}

interface PrerenderManifest {
  routes: Record<string, PrerenderRoute>;
  dynamicRoutes: Record<string, { fallback?: string | false | null }>;
}

const manifests = new Map<string, Promise<PrerenderManifest>>();

/** prerender-manifest.json next to `serverDistDir` (read once; empty when missing or unreadable). */
export function prerenderManifest(serverDistDir: string): Promise<PrerenderManifest> {
  let manifest = manifests.get(serverDistDir);
  if (!manifest) {
    manifest = fsp
      .readFile(path.join(serverDistDir, "..", "prerender-manifest.json"), "utf8")
      .then((raw) => {
        const m = JSON.parse(raw) as Partial<PrerenderManifest>;
        return { routes: m.routes ?? {}, dynamicRoutes: m.dynamicRoutes ?? {} };
      })
      .catch(() => ({ routes: {}, dynamicRoutes: {} }));
    manifests.set(serverDistDir, manifest);
  }
  return manifest;
}

/**
 * True when a cache miss for `key` would answer 404: a prerendered path of a dynamic route without
 * fallback (`dynamicParams = false`). Unknown (no manifest) counts as true - the safe answer.
 */
export async function missWouldNotFound(serverDistDir: string | undefined, key: string): Promise<boolean> {
  if (!serverDistDir) return true;
  const { routes, dynamicRoutes } = await prerenderManifest(serverDistDir);
  if (Object.keys(routes).length === 0) return true;
  const src = routes[routeOfCacheKey(key)]?.srcRoute;
  return Boolean(src && dynamicRoutes[src]?.fallback === false);
}

/** Minimal fs for FileSystemCache when Next's own is not at hand (prewarm): it only reads and stats. */
const nodeFs = {
  readFile: (file: string, encoding?: BufferEncoding) => (encoding ? fsp.readFile(file, encoding) : fsp.readFile(file)),
  stat: (file: string) => fsp.stat(file),
  existsSync: () => false,
};

let fileSystemCacheClass: Promise<FileSystemCacheClass | null> | undefined;

async function loadFileSystemCache(logger: ResolvedLogger): Promise<FileSystemCacheClass | null> {
  fileSystemCacheClass ??= (async () => {
    try {
      const mod = (await import(FILE_SYSTEM_CACHE)) as { default?: unknown };
      const candidate = (mod.default as { default?: unknown } | undefined)?.default ?? mod.default;
      if (typeof candidate !== "function") throw new Error("unexpected module shape");
      return candidate as FileSystemCacheClass;
    } catch (err) {
      logger.warn(
        `build-output fallback disabled: cannot load ${FILE_SYSTEM_CACHE} (${err instanceof Error ? err.message : String(err)})`,
      );
      return null;
    }
  })();
  return fileSystemCacheClass;
}

/** Next's cache key for a prerendered route ("/" is stored as "/index"), and back. */
export const cacheKeyOfRoute = (route: string) => (route === "/" ? "/index" : route);
export const routeOfCacheKey = (key: string) => (key === "/index" ? "/" : key);

export class BuildOutput {
  readonly serverDistDir: string;
  readonly #fs: unknown;
  readonly #logger: ResolvedLogger;
  #cache: Promise<FileSystemCacheInstance | null> | undefined;

  constructor(serverDistDir: string, fs: unknown, logger: ResolvedLogger) {
    this.serverDistDir = serverDistDir;
    this.#fs = fs ?? nodeFs;
    this.#logger = logger;
  }

  #fileSystemCache(): Promise<FileSystemCacheInstance | null> {
    this.#cache ??= loadFileSystemCache(this.#logger).then((FileSystemCache) =>
      FileSystemCache
        ? new FileSystemCache({
            fs: this.#fs,
            serverDistDir: this.serverDistDir,
            flushToDisk: false,
            maxMemoryCacheSize: 0,
            revalidatedTags: [],
            _requestHeaders: {},
          })
        : null,
    );
    return this.#cache;
  }

  /** The prerendered entry for `key`, or null (not prerendered, unreadable, fallback unavailable). */
  async read(key: string, ctx: { kind: string; isRoutePPREnabled?: boolean; isFallback?: boolean }): Promise<BuildOutputEntry | null> {
    if (!BUILD_OUTPUT_KINDS.has(ctx.kind)) return null;
    try {
      const cache = await this.#fileSystemCache();
      const entry = cache ? await cache.get(key, { kind: ctx.kind, isRoutePPREnabled: ctx.isRoutePPREnabled, isFallback: ctx.isFallback }) : null;
      return entry?.value ? entry : null;
    } catch {
      return null;
    }
  }

  /** prerender-manifest.json routes (empty when missing or unreadable). */
  async routes(): Promise<Record<string, PrerenderRoute>> {
    return (await prerenderManifest(this.serverDistDir)).routes;
  }

  /** initialRevalidateSeconds of a prerendered key; undefined when it is not a prerendered route. */
  async revalidateOf(key: string): Promise<number | false | undefined> {
    const route = (await this.routes())[routeOfCacheKey(key)];
    return route ? (route.initialRevalidateSeconds ?? false) : undefined;
  }

  /** Kind of a prerendered key on disk (APP_PAGE: .html, APP_ROUTE: .body) and its meta file, or null. */
  async kindOf(key: string): Promise<{ kind: "APP_PAGE" | "APP_ROUTE"; postponed: boolean } | null> {
    const base = path.join(this.serverDistDir, "app", key);
    const exists = (file: string) =>
      fsp.stat(file).then(
        (s) => s.isFile(),
        () => false,
      );
    if (await exists(`${base}.html`)) {
      let postponed = false;
      try {
        postponed = (JSON.parse(await fsp.readFile(`${base}.meta`, "utf8")) as { postponed?: unknown }).postponed != null;
      } catch {
        // no meta: a plain static page
      }
      return { kind: "APP_PAGE", postponed };
    }
    if (await exists(`${base}.body`)) return { kind: "APP_ROUTE", postponed: false };
    return null;
  }
}
