/**
 * Writes invalidations into the shared tag state (both handlers). One HSET per call; with
 * `tagStateTtlSeconds` the written fields also get a per-field TTL (HEXPIRE, Redis >= 7.4, P6):
 * `tagStateTtlSeconds` after the latest time the update records (a future `expired` included). On a
 * Redis without HEXPIRE the TTL is dropped with one warning; the invalidation itself still applies.
 */
import type { ResolvedConfig } from "./config";
import { tagStateKey } from "./keys";
import { describeError } from "./logger";
import type { Runner } from "./runner";
import { updateFields } from "./tag-state";

export class TagStateWriter {
  readonly #runner: Runner;
  readonly #cfg: ResolvedConfig;
  #hexpire: boolean;

  constructor(runner: Runner, cfg: ResolvedConfig) {
    this.#runner = runner;
    this.#cfg = cfg;
    this.#hexpire = cfg.tagStateTtlSeconds > 0;
  }

  /** Records an invalidation of `tags` (throws when the HSET fails). */
  async write(tags: readonly string[], durations: { expire?: number } | undefined): Promise<void> {
    const now = Date.now();
    const fields = updateFields(tags, durations, now);
    const key = tagStateKey(this.#cfg.namespace);
    await this.#runner.run("write", (client) => client.hSet(key, fields));
    if (!this.#hexpire) return;
    const latest = Math.max(now, ...Object.values(fields).map(Number));
    const seconds = this.#cfg.tagStateTtlSeconds + Math.ceil((latest - now) / 1000);
    try {
      await this.#runner.run("write", (client) => client.hExpire(key, Object.keys(fields), seconds));
    } catch (err) {
      if (/unknown command/i.test(describeError(err))) {
        this.#hexpire = false;
        this.#cfg.logger.warn(`tagStateTtlSeconds needs Redis >= 7.4 (HEXPIRE): tag state fields are kept without a TTL (${describeError(err)})`);
      }
      // otherwise best effort: the field keeps the previous TTL or none
    }
  }
}
