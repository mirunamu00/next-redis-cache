/**
 * Old-build cleanup and background maintenance (ROADMAP.md section 5.5, issue 7-9).
 *
 * Every build writes under `{ns}:{buildId}:...`. The registry `{ns}:_builds` (ZSET build id -> last
 * start time) remembers which builds started when. At every start (startCacheMaintenance):
 *   1. keep the current build and the `keepPrevious` most recently started other builds (a rollback
 *      re-registers the old build, which becomes current again);
 *   2. every other owner - registered or not (keys of builds from before the registry, 1.x layouts) - is
 *      deleted only when EVERY key of it has been idle (OBJECT IDLETIME) for at least `minIdleSeconds`:
 *      an old instance still serving during a rolling update keeps reading its keys, so they survive
 *      the rollout. An idle time that cannot be read (LFU eviction policy) counts as "in use";
 *   3. keys of previous builds and of builds kept by rule 2 get a TTL cap (`retiredTtlSeconds`) - only
 *      where they have no TTL or a longer one, because EXPIRE refreshes the access time.
 * Owners starting with "_" are reserved (`_tagstate`, `_builds`) and never touched - except the tag hash
 * names 1.x used, which 2.x does not read.
 * Deletion uses UNLINK in batches; nothing is collected beyond one owner's key list.
 */
import { buildIdResolver, resolveConfig } from "./config";
import { escapeGlob, ownerOf, registryKey } from "./keys";
import { describeError } from "./logger";
import { prewarmFromBuildOutput, type PrewarmResult } from "./prewarm";
import { Runner, withTimeout } from "./runner";
import type { AnyRedisClient, RedisCacheConfig } from "./types";

export const DEFAULT_KEEP_PREVIOUS = 1;
export const DEFAULT_MIN_IDLE_SECONDS = 30 * 60;
export const DEFAULT_RETIRED_TTL_SECONDS = 24 * 60 * 60;
export const DEFAULT_ATTEMPTS = 10;

/** Tag hash names of 1.x (defaults and the README's): unused by 2.x, so they are cleaned like old builds. */
const V1_TAG_HASHES = new Set(["__sharedTags__", "__sharedTagsTtl__", "__revalidated_tags__", "_tags", "_tagTtls", "_revalidated"]);

const isReserved = (owner: string) => owner.startsWith("_") && !V1_TAG_HASHES.has(owner);

export interface CleanupOptions {
  namespace: string;
  /** The build that is starting now (kept, registered as the latest). */
  buildId: string;
  /** Previously started builds to keep besides the current one (default 1). */
  keepPrevious?: number;
  /** Other builds are deleted only when all their keys were idle this long (default 1800). */
  minIdleSeconds?: number;
  /** TTL cap for kept previous and deferred builds (default 86400). */
  retiredTtlSeconds?: number;
  /** Keys per SCAN page / UNLINK / pipeline batch (default 500). */
  batchSize?: number;
  /** Timeout of each Redis command in ms (default 5000). */
  timeoutMs?: number;
  /** Registration time (default now). */
  now?: number;
}

export interface CleanupResult {
  deleted: number;
  /** The current build and the previous builds kept. */
  kept: string[];
  removedBuilds: string[];
  /** Builds that are not kept but were used recently (probably still serving): kept for now, TTL capped. */
  deferredBuilds: string[];
  ttlCapped: number;
}

/**
 * Registers `buildId` and removes the keys of old builds (rules above). Rejects on Redis errors; use
 * startCacheMaintenance for a background run with retries that never rejects.
 */
export async function cleanupOldBuilds(client: AnyRedisClient, options: CleanupOptions): Promise<CleanupResult> {
  const {
    namespace,
    buildId,
    keepPrevious = DEFAULT_KEEP_PREVIOUS,
    minIdleSeconds = DEFAULT_MIN_IDLE_SECONDS,
    retiredTtlSeconds = DEFAULT_RETIRED_TTL_SECONDS,
    batchSize = 500,
    timeoutMs = 5000,
    now = Date.now(),
  } = options;
  const t = <T>(p: Promise<T>) => withTimeout(p, timeoutMs);
  const registry = registryKey(namespace);

  await t(client.zAdd(registry, { score: now, value: buildId }));
  // ascending by start time -> most recent first
  const registered = ((await t(client.zRange(registry, 0, -1))) as unknown[]).map(String).reverse();
  const previous = registered.filter((id) => id !== buildId).slice(0, Math.max(0, keepPrevious));
  const keep = new Set([buildId, ...previous]);

  const byOwner = new Map<string, string[]>();
  const match = `${escapeGlob(namespace)}:*`;
  let cursor = "0";
  do {
    const reply = (await t(client.scan(cursor, { MATCH: match, COUNT: batchSize }))) as { cursor: unknown; keys: unknown[] };
    cursor = String(reply.cursor);
    for (const raw of reply.keys) {
      const key = String(raw);
      const owner = ownerOf(namespace, key);
      if (!owner || isReserved(owner)) continue;
      const list = byOwner.get(owner);
      if (list) list.push(key);
      else byOwner.set(owner, [key]);
    }
  } while (cursor !== "0");

  let deleted = 0;
  let ttlCapped = 0;
  const removedBuilds: string[] = [];
  const deferredBuilds: string[] = [];
  for (const [owner, keys] of byOwner) {
    if (keep.has(owner)) continue;
    if (await allIdle(client, keys, minIdleSeconds, batchSize, t)) {
      for (let i = 0; i < keys.length; i += batchSize) deleted += Number(await t(client.unlink(keys.slice(i, i + batchSize))));
      removedBuilds.push(owner);
    } else {
      deferredBuilds.push(owner);
      ttlCapped += await capTtl(client, keys, retiredTtlSeconds, batchSize, t);
    }
  }
  for (const id of previous) {
    const keys = byOwner.get(id);
    if (keys) ttlCapped += await capTtl(client, keys, retiredTtlSeconds, batchSize, t);
  }

  // The registry keeps the kept and the deferred builds (the deferred ones are looked at again next time)
  const deferred = new Set(deferredBuilds);
  const dropped = registered.filter((id) => !keep.has(id) && !deferred.has(id));
  if (dropped.length > 0) await t(client.zRem(registry, dropped));

  return { deleted, kept: [...keep], removedBuilds, deferredBuilds, ttlCapped };
}

async function allIdle(
  client: AnyRedisClient,
  keys: string[],
  minIdleSeconds: number,
  batchSize: number,
  t: <T>(p: Promise<T>) => Promise<T>,
): Promise<boolean> {
  for (let i = 0; i < keys.length; i += batchSize) {
    let idles: unknown[];
    try {
      idles = await t(Promise.all(keys.slice(i, i + batchSize).map((k) => client.objectIdleTime(k))));
    } catch {
      return false; // idle time unknown (LFU policy): treat as in use
    }
    // null: the key expired or was deleted after SCAN
    if (idles.some((s) => s !== null && Number(s) < minIdleSeconds)) return false;
  }
  return true;
}

/**
 * Caps the TTL of `keys` at `ttlSeconds` where they have none or a longer one. TTL is read first:
 * EXPIRE updates the access time, so capping every time would make a deferred build look used forever.
 * Best effort - a failure is retried at the next start.
 */
async function capTtl(
  client: AnyRedisClient,
  keys: string[],
  ttlSeconds: number,
  batchSize: number,
  t: <T>(p: Promise<T>) => Promise<T>,
): Promise<number> {
  let capped = 0;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    try {
      const ttls = (await t(Promise.all(batch.map((k) => client.ttl(k))))) as number[];
      const targets = batch.filter((_, j) => ttls[j] === -1 || ttls[j]! > ttlSeconds);
      await t(Promise.all(targets.map((k) => client.expire(k, ttlSeconds))));
      capped += targets.length;
    } catch {
      // next start
    }
  }
  return capped;
}

export interface RetryOptions {
  /** Attempts in total, waiting for the connection included (default 10). */
  attempts?: number;
  /** First retry delay in ms, doubled per attempt (default 2000). */
  baseDelayMs?: number;
  /** Longest retry delay in ms (default 300000). */
  maxDelayMs?: number;
}

export interface GiveUp {
  gaveUp: true;
  attempts: number;
  /** "disconnected": Redis was never ready (or the connection dropped); "error": a command failed. */
  cause: "disconnected" | "error";
  error?: unknown;
}

export type Attempted<T> = { gaveUp: false; attempts: number; value: T } | GiveUp;

/**
 * Runs `task` once the client is ready: right away if it is, on its "ready" event otherwise, and again
 * with exponential backoff after a failure - `attempts` times in total. Never rejects; timers are unref'd.
 */
export function whenReady<T>(client: AnyRedisClient, task: () => Promise<T>, { attempts = DEFAULT_ATTEMPTS, baseDelayMs = 2000, maxDelayMs = 300_000 }: RetryOptions = {}): Promise<Attempted<T>> {
  return new Promise((resolve) => {
    let tried = 0;
    let running = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const emitter = client as unknown as { on?: (e: string, f: () => void) => void; off?: (e: string, f: () => void) => void };

    const finish = (result: Attempted<T>) => {
      done = true;
      clearTimeout(timer);
      emitter.off?.("ready", onReady);
      resolve(result);
    };
    const onReady = () => {
      if (done || running) return;
      clearTimeout(timer);
      void attempt();
    };
    const scheduleNext = (cause: GiveUp["cause"], error?: unknown) => {
      tried += 1;
      if (tried >= attempts) return finish({ gaveUp: true, attempts: tried, cause, error });
      const delay = Math.min(baseDelayMs * 2 ** (tried - 1), maxDelayMs);
      clearTimeout(timer);
      timer = setTimeout(() => void attempt(), delay);
      (timer as { unref?: () => void }).unref?.();
    };
    async function attempt() {
      if (done || running) return;
      if (!client.isReady) return scheduleNext("disconnected");
      running = true;
      try {
        const value = await task();
        finish({ gaveUp: false, attempts: tried + 1, value });
      } catch (error) {
        scheduleNext(client.isReady ? "error" : "disconnected", error);
      } finally {
        running = false;
      }
    }

    emitter.on?.("ready", onReady);
    void attempt();
  });
}

export interface MaintenanceOptions {
  /** The same config the handlers use (client, namespace, buildId, logger, ...). */
  config: RedisCacheConfig;
  /** Old-build cleanup (default on); `false` disables it. */
  cleanup?:
    | (Pick<CleanupOptions, "keepPrevious" | "minIdleSeconds" | "retiredTtlSeconds" | "batchSize" | "timeoutMs"> & RetryOptions)
    | false;
  /** Prewarm Redis from the build output (default false: the build-output fallback re-seeds on demand). */
  prewarm?: boolean | ({ concurrency?: number; distDir?: string } & RetryOptions);
}

export interface MaintenanceResult {
  /** Why nothing ran: build phase / disabled, or no Redis client configured. */
  skipped?: "disabled" | "no-client";
  cleanup?: Attempted<CleanupResult>;
  prewarm?: Attempted<PrewarmResult>;
}

function describeGiveUp(what: string, g: GiveUp): string {
  const why = g.cause === "error" ? `Redis command error (${describeError(g.error).replace(/\s+/g, " ").trim()})` : "Redis not connected";
  return `${what} gave up after ${g.attempts} attempts: ${why}; it runs again at the next start`;
}

function describeCleanup(r: CleanupResult, buildId: string): string {
  const kept = r.kept.map((id) => (id === buildId ? `${id} (current)` : `${id} (previous)`)).join(", ");
  const parts = [`cleanup: deleted ${r.deleted} keys`];
  if (r.removedBuilds.length > 0) parts.push(`removed builds ${r.removedBuilds.join(", ")}`);
  parts.push(`kept ${kept}`);
  if (r.deferredBuilds.length > 0) parts.push(`deferred (recently used) ${r.deferredBuilds.join(", ")}`);
  if (r.ttlCapped > 0) parts.push(`TTL capped on ${r.ttlCapped} keys`);
  return parts.join("; ");
}

/**
 * Starts background maintenance from `instrumentation.ts` (register): old-build cleanup and, optionally,
 * prewarming. Never awaited by the caller and never rejects: it waits for Redis to be ready, retries with
 * backoff and logs one line per task. `done` resolves with the results (tests, logging).
 *
 * ```ts
 * // instrumentation.ts (Node runtime)
 * const { startCacheMaintenance } = await import("@mirunamu/next-redis-cache/instrumentation");
 * startCacheMaintenance({ config }); // cleanup on, prewarm off
 * ```
 */
export function startCacheMaintenance(options: MaintenanceOptions): { done: Promise<MaintenanceResult> } {
  const done = (async (): Promise<MaintenanceResult> => {
    const cfg = resolveConfig(options.config);
    if (cfg.isDisabled()) return { skipped: "disabled" };
    const client = await new Runner(cfg).resolveClient();
    if (!client) return { skipped: "no-client" };
    const buildId = buildIdResolver(cfg)();
    const result: MaintenanceResult = {};
    const tasks: Promise<void>[] = [];

    const cleanup = options.cleanup ?? {};
    if (cleanup !== false) {
      if (!client.isReady) cfg.logger.info("cleanup: waiting for Redis");
      tasks.push(
        whenReady(client, () => cleanupOldBuilds(client, { ...cleanup, namespace: cfg.namespace, buildId }), cleanup).then((r) => {
          result.cleanup = r;
          if (r.gaveUp) cfg.logger.warn(describeGiveUp("cleanup", r));
          else cfg.logger.info(describeCleanup(r.value, buildId));
        }),
      );
    }

    const prewarm = options.prewarm ?? false;
    if (prewarm) {
      const o = prewarm === true ? {} : prewarm;
      tasks.push(
        whenReady(
          client,
          async () => {
            const r = await prewarmFromBuildOutput({ ...options.config, buildId }, { concurrency: o.concurrency, distDir: o.distDir });
            if (r.unavailable) throw new Error("Redis became unavailable");
            return r;
          },
          o,
        ).then((r) => {
          result.prewarm = r;
          if (r.gaveUp) cfg.logger.warn(describeGiveUp("prewarm", r));
        }),
      );
    }
    await Promise.all(tasks);
    return result;
  })().catch((err: unknown): MaintenanceResult => {
    // configuration errors surface here; maintenance never breaks startup
    console.warn(`[next-redis-cache] maintenance failed: ${describeError(err)}`);
    return {};
  });
  return { done };
}
