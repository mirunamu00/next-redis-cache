/**
 * Always-on error reporting for cache operations.
 *
 * Every failure used to be logged only with NEXT_PRIVATE_DEBUG_CACHE, so a broken Redis was silent
 * in production. Logging every failure instead would flood the logs during an outage (each request
 * fails). This reporter logs transitions: the first failure is a console.warn, further failures are
 * counted and summarized at most once per minute, and the first success afterwards is reported
 * once with console.info.
 */

const PREFIX = "[next-redis-cache]";
const SUMMARY_INTERVAL_MS = 60_000;
const MAX_KEY_LENGTH = 120;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shorten(key: string): string {
  return key.length > MAX_KEY_LENGTH ? `${key.slice(0, MAX_KEY_LENGTH)}...` : key;
}

export class ErrorReporter {
  readonly #label: string;
  #failing = false;
  #suppressed = 0;
  #lastWarnAt = 0;

  constructor(label: string) {
    this.#label = label;
  }

  /** Records a failed operation. Logs on the transition to failing, then summarizes. */
  failure(op: string, key: string, err: unknown): void {
    const now = Date.now();
    if (!this.#failing) {
      this.#failing = true;
      this.#suppressed = 0;
      this.#lastWarnAt = now;
      console.warn(
        `${PREFIX} ${this.#label} ${op} failed (${shorten(key)}): ${describe(err)}. ` +
          "Serving cache misses; further errors are summarized until Redis recovers."
      );
      return;
    }
    this.#suppressed += 1;
    if (now - this.#lastWarnAt >= SUMMARY_INTERVAL_MS) {
      console.warn(
        `${PREFIX} ${this.#label} still failing: ${this.#suppressed} more errors since the last warning ` +
          `(latest: ${op} ${shorten(key)}: ${describe(err)})`
      );
      this.#suppressed = 0;
      this.#lastWarnAt = now;
    }
  }

  /** Records a successful Redis round trip. Logs once when recovering from failures. */
  success(): void {
    if (!this.#failing) return;
    this.#failing = false;
    console.info(
      `${PREFIX} ${this.#label} recovered (${this.#suppressed} errors since the last warning)`
    );
    this.#suppressed = 0;
  }
}
