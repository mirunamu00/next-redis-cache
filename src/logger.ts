/**
 * Logging (ROADMAP.md section 5.3, decision D13).
 *
 * Every line is prefixed with "[next-redis-cache]". Failures are logged on transitions, never per
 * request: the first failure of an outage is a warning, further failures are summarized at most
 * once a minute, and the first success afterwards is logged once as info.
 */
import type { CacheEvent, HandlerName, LogLevel, Logger } from "./types";

const PREFIX = "[next-redis-cache]";
const SUMMARY_INTERVAL_MS = 60_000;
const MAX_KEY_LENGTH = 120;

export type ResolvedLogger = Record<LogLevel, (message: string) => void>;

const silent = () => {};

export function resolveLogger(logger: Logger | false | undefined): ResolvedLogger {
  if (logger === false) return { debug: silent, info: silent, warn: silent, error: silent };
  // console methods are looked up per call, so a console patched after startup (log shippers) is used
  const base: Logger =
    logger ?? {
      debug: process.env.NEXT_PRIVATE_DEBUG_CACHE ? (...a: unknown[]) => console.debug(...a) : undefined,
      info: (...a: unknown[]) => console.info(...a),
      warn: (...a: unknown[]) => console.warn(...a),
      error: (...a: unknown[]) => console.error(...a),
    };
  const wrap = (level: LogLevel) => {
    const fn = base[level];
    return fn ? (message: string) => fn(`${PREFIX} ${message}`) : silent;
  };
  return { debug: wrap("debug"), info: wrap("info"), warn: wrap("warn"), error: wrap("error") };
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function shortenKey(key: string): string {
  return key.length > MAX_KEY_LENGTH ? `${key.slice(0, MAX_KEY_LENGTH)}...` : key;
}

/**
 * Reports a failed operation: logged on transitions (an intentionally absent client or a disabled
 * handler is not a failure) and emitted as an "error" event (unavailability is not an error event:
 * the caller emits a miss with reason "unavailable").
 */
export function reportFailure(
  reporter: FailureReporter,
  cfg: { emit: (e: CacheEvent) => void },
  handler: HandlerName | "maintenance",
  op: string,
  key: string,
  err: unknown,
): void {
  const reason = (err as { reason?: string } | null)?.reason;
  const unavailable = (err as { name?: string } | null)?.name === "RedisUnavailableError";
  if (unavailable && (reason === "no-client" || reason === "disabled")) return;
  reporter.failure(op, key, err);
  if (!unavailable) cfg.emit({ type: "error", handler, op, key, error: err });
}

/** Transition-based failure logging for one handler (legacy, use-cache, maintenance). */
export class FailureReporter {
  readonly #label: string;
  readonly #logger: ResolvedLogger;
  #failing = false;
  #suppressed = 0;
  #lastWarnAt = 0;

  constructor(label: string, logger: ResolvedLogger) {
    this.#label = label;
    this.#logger = logger;
  }

  get failing(): boolean {
    return this.#failing;
  }

  /** Records a failed Redis operation. Warns on the transition to failing, then summarizes. */
  failure(op: string, key: string, err: unknown): void {
    const now = Date.now();
    if (!this.#failing) {
      this.#failing = true;
      this.#suppressed = 0;
      this.#lastWarnAt = now;
      this.#logger.warn(
        `${this.#label} ${op} failed (${shortenKey(key)}): ${describeError(err)}. ` +
          "Serving without Redis; further errors are summarized until Redis recovers.",
      );
      return;
    }
    this.#suppressed += 1;
    if (now - this.#lastWarnAt >= SUMMARY_INTERVAL_MS) {
      this.#logger.warn(
        `${this.#label} still failing: ${this.#suppressed} more errors since the last warning ` +
          `(latest: ${op} ${shortenKey(key)}: ${describeError(err)})`,
      );
      this.#suppressed = 0;
      this.#lastWarnAt = now;
    }
  }

  /** Records a successful Redis round trip. Logs once when recovering. */
  success(): void {
    if (!this.#failing) return;
    this.#failing = false;
    this.#logger.info(`${this.#label} recovered (${this.#suppressed} errors since the last warning)`);
    this.#suppressed = 0;
  }
}
