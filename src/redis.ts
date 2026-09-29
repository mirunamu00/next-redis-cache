/**
 * `@mirunamu/next-redis-cache/redis` - a Redis connection that never blocks startup or requests.
 *
 * With @redis/client's default reconnect strategy, `await client.connect()` never settles while Redis
 * is unreachable (7-2). connectRedis waits at most `waitMs` for the first connection and returns the
 * client either way; it keeps reconnecting in the background, and the handlers send nothing until it
 * is ready. One client per URL is shared by every caller in the process (the legacy handler, the
 * "use cache" handler and the maintenance task are loaded as separate modules by Next.js, so the
 * registry lives on globalThis).
 */
import type { RedisClientOptions } from "@redis/client";
import { describeError, resolveLogger, type ResolvedLogger } from "./logger";
import type { AnyRedisClient, Logger } from "./types";

export interface ConnectRedisOptions {
  /** Longest wait for the first connection, in ms (default 1000). */
  waitMs?: number;
  /** Name used in log lines (default "redis"). */
  label?: string;
  /** Extra createClient options (url is always the given one). */
  clientOptions?: Omit<RedisClientOptions, "url">;
  logger?: Logger | false;
  /** Share one client per URL in this process (default true). */
  shared?: boolean;
}

export const DEFAULT_CONNECT_WAIT_MS = 1000;

const REGISTRY = Symbol.for("@mirunamu/next-redis-cache/clients");

function registry(): Map<string, Promise<AnyRedisClient>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<AnyRedisClient>> | undefined>;
  let map = g[REGISTRY];
  if (!map) {
    map = new Map();
    g[REGISTRY] = map;
  }
  return map;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/** Removes credentials from a URL for log lines. */
function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<invalid url>";
  }
}

async function open(url: string, o: ConnectRedisOptions, logger: ResolvedLogger): Promise<AnyRedisClient> {
  const { createClient } = await import("@redis/client");
  const label = o.label ?? "redis";
  const waitMs = o.waitMs ?? DEFAULT_CONNECT_WAIT_MS;
  const client = createClient({ ...(o.clientOptions ?? {}), url }) as unknown as AnyRedisClient;

  // A reconnecting client emits "error" on every attempt: log transitions only
  let healthy = false;
  let warned = false;
  client.on("ready", () => {
    if (warned && !healthy) logger.info(`${label}: connected to ${redact(url)} again`);
    healthy = true;
  });
  client.on("error", (err: unknown) => {
    if (healthy || !warned) {
      logger.warn(`${label}: Redis unavailable (${describeError(err)}); caching without Redis until it reconnects`);
      warned = true;
    }
    healthy = false;
  });

  const connecting = client.connect().catch((err: unknown) => {
    logger.error(`${label}: gave up connecting to ${redact(url)}: ${describeError(err)}`);
  });
  await Promise.race([connecting, delay(waitMs)]);
  if (!client.isReady && !warned) {
    logger.warn(`${label}: not connected within ${waitMs}ms; connecting in the background`);
    warned = true;
  }
  return client;
}

/**
 * Creates (or returns the shared) client for `url`, waiting at most `waitMs` for the first connection.
 * Returns null without a URL - handlers then run without Redis (build output fallback only).
 */
export function connectRedis(url: string | undefined | null, options: ConnectRedisOptions = {}): Promise<AnyRedisClient | null> {
  if (!url) return Promise.resolve(null);
  const logger = resolveLogger(options.logger);
  if (options.shared === false) return open(url, options, logger);
  const clients = registry();
  let client = clients.get(url);
  if (!client) {
    client = open(url, options, logger);
    clients.set(url, client);
    client.catch(() => clients.delete(url));
  }
  return client;
}

/** Destroys every shared client (tests, graceful shutdown). */
export async function closeSharedClients(): Promise<void> {
  const clients = registry();
  const all = [...clients.values()];
  clients.clear();
  for (const p of all) {
    try {
      const c = await p;
      if (c.isOpen) c.destroy();
    } catch {
      // never opened
    }
  }
}
