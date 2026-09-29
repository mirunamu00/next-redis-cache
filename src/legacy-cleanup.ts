/**
 * 1.x pattern-based key cleanup, kept for migration (deprecated in 2.x, removed in 3.0).
 * The 2.x replacement is `cleanupOldBuilds` / `startCacheMaintenance`, which keeps the previous
 * build and every build that is still being read.
 */
import { createClient } from "@redis/client";
import { withTimeout } from "./runner";

export interface CleanupPattern {
  /** Redis KEYS pattern to scan (e.g. "myapp:*") */
  scan: string;
  /** Keep this exact key (e.g. "myappTags:abc123") */
  keepExact?: string;
  /** Keep keys starting with this prefix (e.g. "myapp:abc123:") */
  keepPrefix?: string;
}

export interface CleanupOldBuildKeysOptions {
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

/**
 * Deletes every key matching `patterns` except the kept ones (SCAN + batched UNLINK). Never rejects
 * because of Redis: on a connect or command failure it warns and resolves with the keys deleted so far.
 *
 * @deprecated Deletes keys of builds that may still be serving (rolling updates). Use
 * `startCacheMaintenance` / `cleanupOldBuilds` from "@mirunamu/next-redis-cache/instrumentation".
 * Removed in 3.0.
 */
export async function cleanupOldBuildKeys(options: CleanupOldBuildKeysOptions): Promise<{ deleted: number }> {
  const { redisUrl, patterns, timeoutMs = 5000 } = options;
  const client = createClient({
    url: redisUrl,
    socket: { connectTimeout: timeoutMs, reconnectStrategy: false },
  });
  client.on("error", (err: Error) => console.warn("[cache-cleanup:redis]", err.message));

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
        const reply = await withTimeout(client.scan(cursor, { MATCH: scan, COUNT: SCAN_COUNT }), timeoutMs);
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
    console.warn(`[cache-cleanup] Gave up after deleting ${deleted} keys: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      client.destroy();
    } catch {
      // never connected
    }
  }
  return { deleted };
}
