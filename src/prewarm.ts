/**
 * Prewarm Redis from the build output (ROADMAP.md 5.4, issue 7-4).
 *
 * Reads every prerendered route of prerender-manifest.json with Next's own FileSystemCache (the same
 * path as the build-output fallback), so a prewarmed entry is exactly the entry Next would have produced:
 * segment data keyed by the meta segmentPaths, "/" stored as "/index", route handlers (.body), the meta
 * status and postponed state. Entries are written with SET NX (never over a newer entry) and the file
 * time as lastModified. With the build-output fallback on, prewarming is optional (off by default, Q9):
 * every miss is served from the build output and re-seeded on demand.
 */
import path from "node:path";
import { BuildOutput, cacheKeyOfRoute } from "./build-output";
import { resolveConfig } from "./config";
import { LegacyCore } from "./legacy-handler";
import type { RedisCacheConfig } from "./types";

export interface PrewarmOptions {
  /** Entries written in parallel (default 8). */
  concurrency?: number;
  /** The Next.js build output directory (default `<cwd>/.next`). */
  distDir?: string;
}

export interface PrewarmResult {
  /** Entries written. */
  prewarmed: number;
  /** Routes skipped: already in Redis, or without App Router output on disk (Pages Router). */
  skipped: number;
  /** Routes that could not be read or written. */
  failed: number;
  /** Redis was not usable when the prewarm started (nothing was attempted). */
  unavailable?: boolean;
}

export async function prewarmFromBuildOutput(config: RedisCacheConfig, options: PrewarmOptions = {}): Promise<PrewarmResult> {
  const cfg = resolveConfig(config);
  const distDir = options.distDir ?? path.join(process.cwd(), ".next");
  const serverDistDir = path.join(distDir, "server");
  const core = new LegacyCore(cfg);
  core.observe({ serverDistDir, dev: false });
  const result: PrewarmResult = { prewarmed: 0, skipped: 0, failed: 0 };
  try {
    await core.runner.available();
  } catch {
    cfg.logger.warn("prewarm skipped: Redis is not available");
    return { ...result, unavailable: true };
  }

  const output = new BuildOutput(serverDistDir, undefined, cfg.logger);
  const routes = Object.entries(await output.routes());
  const queue = [...routes];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [route, info] = next;
      const key = cacheKeyOfRoute(route);
      try {
        const kind = await output.kindOf(key);
        if (!kind) {
          result.skipped++;
          continue;
        }
        // A partially prerendered page is served without the full RSC payload (Next reads no .rsc for it)
        const entry = await output.read(key, { kind: kind.kind, isRoutePPREnabled: kind.postponed, isFallback: false });
        if (!entry) {
          result.failed++;
          continue;
        }
        const tags = String(entry.value?.headers?.["x-next-cache-tags"] ?? "")
          .split(",")
          .filter(Boolean);
        const meta = { lastModified: entry.lastModified, tags, revalidate: info.initialRevalidateSeconds ?? false };
        const stored = await core.write(key, meta, entry.value, { op: "prewarm", onlyIfAbsent: true });
        if (stored === "stored") result.prewarmed++;
        else if (stored === "exists") result.skipped++;
        else result.failed++;
      } catch {
        result.failed++;
      }
    }
  };
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 8));
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, routes.length)) }, worker));
  cfg.logger.info(`prewarm: ${result.prewarmed} entries written, ${result.skipped} skipped, ${result.failed} failed`);
  return result;
}
