/**
 * The single path every Redis command takes (ROADMAP.md section 5.3):
 *
 *   disabled / no client / circuit open / client not ready  ->  RedisUnavailableError, nothing is sent
 *   otherwise                                                ->  the command, bounded by a timeout
 *
 * Nothing is ever sent (or parked in the client's offline queue) while the client is not ready, and
 * every command promise has a rejection handler (7-3). A timeout opens the circuit breaker for
 * `openMs`: while it is open every call fails immediately instead of waiting for an unresponsive
 * Redis again (A3). The circuit is shared by every handler that uses the same client object.
 *
 * The client's own command `timeout` option only covers the time before a command is written to the
 * socket (@redis/client 5.x commands-queue), not the wait for the reply, so the package bounds the
 * whole round trip itself.
 */
import { RESP_TYPES } from "@redis/client";
import type { ResolvedConfig } from "./config";
import type { AnyRedisClient } from "./types";

export type UnavailableReason = "disabled" | "no-client" | "not-ready" | "circuit-open";

export class RedisUnavailableError extends Error {
  readonly reason: UnavailableReason;
  constructor(reason: UnavailableReason) {
    super(`Redis unavailable (${reason})`);
    this.name = "RedisUnavailableError";
    this.reason = reason;
  }
}

export class RedisTimeoutError extends Error {
  constructor(ms: number) {
    super(`Redis did not answer within ${ms}ms`);
    this.name = "RedisTimeoutError";
  }
}

/** How long the first call waits for a client function (for example connectRedis) to return. */
export const CLIENT_RESOLVE_MS = 3000;

/**
 * Rejects if `promise` does not settle within `ms`. The timer is cleared as soon as the promise
 * settles (7-10) and never keeps the process alive.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, error: () => Error = () => new RedisTimeoutError(ms)): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error()), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface Circuit {
  openUntil: number;
  open: boolean;
}

const circuits = new WeakMap<object, Circuit>();
const binaryClients = new WeakMap<object, AnyRedisClient>();

function circuitOf(client: object): Circuit {
  let c = circuits.get(client);
  if (!c) {
    c = { openUntil: 0, open: false };
    circuits.set(client, c);
  }
  return c;
}

/** The same client with bulk strings returned as Buffers (binary envelopes, no base64). */
export function binaryClient(client: AnyRedisClient): AnyRedisClient {
  let b = binaryClients.get(client);
  if (!b) {
    b = client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer }) as AnyRedisClient;
    binaryClients.set(client, b);
  }
  return b;
}

function isClient(value: unknown): value is AnyRedisClient {
  return typeof value === "object" && value !== null && "isReady" in value;
}

export type CommandKind = "read" | "write";

export class Runner {
  readonly #cfg: ResolvedConfig;
  #client: AnyRedisClient | undefined;
  #pending: Promise<AnyRedisClient | null> | undefined;
  #announcedNoClient = false;

  constructor(cfg: ResolvedConfig) {
    this.#cfg = cfg;
  }

  /** The resolved client, if any (does not resolve a client function). */
  get current(): AnyRedisClient | undefined {
    return this.#client;
  }

  /** Resolves the client source; null when there is none (yet). Never throws. */
  async resolveClient(): Promise<AnyRedisClient | null> {
    if (this.#client) return this.#client;
    const source = this.#cfg.client;
    if (isClient(source)) {
      this.#client = source;
      return source;
    }
    if (typeof source !== "function") return this.#noClient();
    if (!this.#pending) {
      this.#pending = (async () => {
        try {
          const value = await source();
          if (isClient(value)) {
            this.#client = value;
            return value;
          }
          return null;
        } catch (err) {
          this.#cfg.logger.warn(`the client function threw: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        } finally {
          this.#pending = undefined;
        }
      })();
    }
    const pending = this.#pending;
    try {
      const client = await withTimeout(pending, CLIENT_RESOLVE_MS);
      return client ?? this.#noClient();
    } catch {
      return null; // still resolving: this call is served without Redis, later calls reuse the promise
    }
  }

  #noClient(): null {
    if (!this.#announcedNoClient) {
      this.#announcedNoClient = true;
      this.#cfg.logger.info("no Redis client configured (client is null); caching without Redis");
    }
    return null;
  }

  /** True when a command would be sent right now (client resolved and ready, circuit closed). */
  usable(): boolean {
    const client = this.#client;
    if (!client || this.#cfg.isDisabled()) return false;
    return client.isReady && !this.#circuitOpen(client);
  }

  #circuitOpen(client: AnyRedisClient): boolean {
    if (this.#cfg.openMs === 0) return false;
    const c = circuits.get(client);
    return Boolean(c?.open && Date.now() < c.openUntil);
  }

  #opened(client: AnyRedisClient, err: Error): void {
    if (this.#cfg.openMs === 0) return;
    const c = circuitOf(client);
    const wasOpen = c.open;
    c.open = true;
    c.openUntil = Date.now() + this.#cfg.openMs;
    if (!wasOpen) {
      this.#cfg.logger.warn(`${err.message}; skipping Redis for ${this.#cfg.openMs}ms`);
      this.#cfg.emit({ type: "circuit", state: "open", reason: err.message });
    }
  }

  #succeeded(client: AnyRedisClient): void {
    const c = circuits.get(client);
    if (c?.open) {
      c.open = false;
      this.#cfg.logger.info("Redis answers again; circuit closed");
      this.#cfg.emit({ type: "circuit", state: "closed", reason: "command succeeded" });
    }
  }

  /** The client if a command could be sent now; otherwise throws RedisUnavailableError. */
  async available(): Promise<AnyRedisClient> {
    if (this.#cfg.isDisabled()) throw new RedisUnavailableError("disabled");
    const client = this.#client ?? (await this.resolveClient());
    if (!client) throw new RedisUnavailableError("no-client");
    if (this.#circuitOpen(client)) throw new RedisUnavailableError("circuit-open");
    if (!client.isReady) throw new RedisUnavailableError("not-ready");
    return client;
  }

  /**
   * Runs `command` against Redis or throws RedisUnavailableError without sending anything.
   * `command` receives the client and its binary (Buffer-returning) variant.
   */
  async run<T>(kind: CommandKind, command: (client: AnyRedisClient, binary: AnyRedisClient) => Promise<T>): Promise<T> {
    const client = await this.available();
    const ms = kind === "read" ? this.#cfg.readMs : this.#cfg.writeMs;
    // A synchronous throw rejects run() like a failed command would
    const promise = command(client, binaryClient(client));
    try {
      const value = await withTimeout(promise, ms);
      this.#succeeded(client);
      return value;
    } catch (err) {
      if (err instanceof RedisTimeoutError) this.#opened(client, err);
      throw err;
    }
  }
}

export function isUnavailable(err: unknown): err is RedisUnavailableError {
  return err instanceof RedisUnavailableError;
}
