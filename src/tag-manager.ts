/**
 * Redis Hash-based tag management.
 *
 * Shared by both legacy cacheHandler and new use-cache handler.
 * Handles tag registration, revalidation, and expiration tracking.
 */

import type { RedisClientType } from "@redis/client";
import { assertClientReady, runCommand } from "./redis-client";
import { isImplicitTag, type ResolvedRedisOptions } from "./types";

/**
 * 1.0.x recorded `now + expire` for updateTags(tags, durations) (issue 7-1), which kept every entry
 * of the tag a miss until that future time (a year for revalidateTag(tag, "max")). A revalidation
 * time further ahead than this tolerance (clock skew between instances) can only be such a value.
 */
const FUTURE_TOLERANCE_MS = 60_000;

export class TagManager {
  private client: RedisClientType;
  private keyPrefix: string;
  private sharedTagsKey: string;
  private sharedTagsTtlKey: string;
  private revalidatedTagsKey: string;
  private timeoutMs: number;

  constructor(opts: ResolvedRedisOptions) {
    this.client = opts.client;
    this.keyPrefix = opts.keyPrefix;
    this.sharedTagsKey = opts.keyPrefix + opts.sharedTagsKey;
    this.sharedTagsTtlKey = opts.keyPrefix + opts.sharedTagsTtlKey;
    this.revalidatedTagsKey = opts.keyPrefix + opts.revalidatedTagsKey;
    this.timeoutMs = opts.timeoutMs;
  }

  private exec<T>(command: () => Promise<T>): Promise<T> {
    return runCommand(this.client, command, this.timeoutMs);
  }

  /** Register tags for a cache key */
  async setTags(key: string, tags: readonly string[]): Promise<void> {
    await this.exec(
      () => this.client.hSet(this.sharedTagsKey, key, JSON.stringify(tags))
    );
  }

  /** Register TTL for a cache key */
  async setTtl(key: string, expireAt: number): Promise<void> {
    await this.exec(
      () => this.client.hSet(this.sharedTagsTtlKey, key, expireAt.toString())
    );
  }

  /** Check if a cache key's tags entry exists */
  async hasTagEntry(key: string): Promise<boolean> {
    const result = await this.exec(() => this.client.hExists(this.sharedTagsKey, key));
    return !!result;
  }

  /** Delete tag and TTL entries for a cache key */
  async deleteTags(key: string): Promise<void> {
    await Promise.all([
      this.exec(() => this.client.hDel(this.sharedTagsKey, key)),
      this.exec(() => this.client.hDel(this.sharedTagsTtlKey, key)),
    ]);
  }

  /**
   * Check if any of the given tags have been revalidated after the given timestamp.
   * Returns true if the cache entry should be considered stale.
   */
  async isStale(tags: string[], lastModified: number): Promise<boolean> {
    if (tags.length === 0) return false;
    const times = await this.revalidationTimes(tags);
    return times.some((t) => t > lastModified);
  }

  /**
   * Revalidation times (ms, 0 = never) of `tags`. A future time left by 1.0.x is healed: it is
   * treated as "revalidated now" and rewritten as such, so the tag works normally again after one
   * regeneration instead of missing until that future time. (A concurrent updateTags between the
   * read and the rewrite can be moved back by the few milliseconds in between.)
   */
  private async revalidationTimes(tags: string[]): Promise<number[]> {
    const raw = await this.exec(
      () => this.client.hmGet(this.revalidatedTagsKey, tags)
    );
    const now = Date.now();
    const healed: Record<string, string> = {};
    const times = raw.map((value, i) => {
      const t = value ? parseInt(value, 10) : 0;
      if (!Number.isFinite(t)) return 0;
      if (t > now + FUTURE_TOLERANCE_MS) {
        healed[tags[i]!] = now.toString();
        return now;
      }
      return t;
    });
    if (Object.keys(healed).length > 0) {
      await this.exec(() => this.client.hSet(this.revalidatedTagsKey, healed));
    }
    return times;
  }

  /**
   * Revalidate a tag: mark it as revalidated and delete all cache entries
   * associated with it.
   */
  async revalidateTag(tag: string): Promise<void> {
    assertClientReady(this.client);

    // Mark implicit tags with a revalidation timestamp
    if (isImplicitTag(tag)) {
      await this.exec(
        () => this.client.hSet(this.revalidatedTagsKey, tag, Date.now().toString())
      );
    }

    // Scan shared tags to find keys associated with this tag
    const keysToDelete: string[] = [];
    const tagsToDelete: string[] = [];

    let cursor = "0";
    do {
      const result = await this.exec(
        () => this.client.hScan(this.sharedTagsKey, cursor, { COUNT: 10000 })
      );

      for (const { field, value } of result.entries) {
        const tags = JSON.parse(value) as string[];
        if (tags.includes(tag)) {
          keysToDelete.push(this.keyPrefix + field);
          tagsToDelete.push(field);
        }
      }

      cursor = result.cursor;
    } while (cursor !== "0");

    if (keysToDelete.length === 0) return;

    await Promise.all([
      this.exec(() => this.client.unlink(keysToDelete)),
      this.exec(() => this.client.hDel(this.sharedTagsKey, tagsToDelete)),
      this.exec(() => this.client.hDel(this.sharedTagsTtlKey, tagsToDelete)),
    ]);
  }

  /** Clean up expired keys based on TTL */
  async cleanupExpired(): Promise<void> {
    assertClientReady(this.client);

    const keysToDelete: string[] = [];
    const entriesToDelete: string[] = [];
    const now = Date.now();

    let cursor = "0";
    do {
      const result = await this.exec(
        () => this.client.hScan(this.sharedTagsTtlKey, cursor, { COUNT: 10000 })
      );

      for (const { field, value } of result.entries) {
        if (now > Number(value) * 1000) {
          keysToDelete.push(this.keyPrefix + field);
          entriesToDelete.push(field);
        }
      }

      cursor = result.cursor;
    } while (cursor !== "0");

    if (entriesToDelete.length === 0) return;

    await Promise.all([
      this.exec(() => this.client.unlink(keysToDelete)),
      this.exec(() => this.client.hDel(this.sharedTagsKey, entriesToDelete)),
      this.exec(() => this.client.hDel(this.sharedTagsTtlKey, entriesToDelete)),
    ]);
  }

  // --- use-cache handler specific methods ---

  /**
   * Get the maximum revalidation timestamp for the given tags.
   * Returns 0 if none of the tags were ever revalidated.
   */
  async getTagExpiration(tags: string[]): Promise<number> {
    if (tags.length === 0) return 0;
    const times = await this.revalidationTimes(tags);
    return Math.max(0, ...times);
  }

  /**
   * Update tag timestamps for revalidation (use-cache handler).
   *
   * Next's default handler records `{ stale: now, expired: now + expire }` when durations are given
   * (revalidateTag(tag, profile)): entries are served stale once while they regenerate. 1.x stores a
   * single time per tag, so both cases record `now`: the next read of an older entry is a miss that
   * regenerates it (like updateTag). Serving the stale entry meanwhile needs the 2.0 tag state.
   * Never a future time - that disabled the cache for the tag until then (7-1).
   */
  async updateTagTimestamps(
    tags: string[],
    _durations?: { expire?: number }
  ): Promise<void> {
    if (tags.length === 0) return;
    assertClientReady(this.client);

    const now = Date.now().toString();

    const entries: Record<string, string> = {};
    for (const tag of tags) {
      entries[tag] = now;
    }

    if (Object.keys(entries).length > 0) {
      await this.exec(() => this.client.hSet(this.revalidatedTagsKey, entries));
    }
  }
}
