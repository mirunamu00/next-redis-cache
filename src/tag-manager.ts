/**
 * Redis Hash-based tag management.
 *
 * Shared by both legacy cacheHandler and new use-cache handler.
 * Handles tag registration, revalidation, and expiration tracking.
 */

import type { RedisClientType } from "@redis/client";
import { assertClientReady, withTimeout } from "./redis-client";
import { isImplicitTag, type ResolvedRedisOptions } from "./types";

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

  private exec<T>(promise: Promise<T>): Promise<T> {
    assertClientReady(this.client);
    return withTimeout(promise, this.timeoutMs);
  }

  /** Register tags for a cache key */
  async setTags(key: string, tags: readonly string[]): Promise<void> {
    await this.exec(
      this.client.hSet(this.sharedTagsKey, key, JSON.stringify(tags))
    );
  }

  /** Register TTL for a cache key */
  async setTtl(key: string, expireAt: number): Promise<void> {
    await this.exec(
      this.client.hSet(this.sharedTagsTtlKey, key, expireAt.toString())
    );
  }

  /** Check if a cache key's tags entry exists */
  async hasTagEntry(key: string): Promise<boolean> {
    const result = await this.exec(this.client.hExists(this.sharedTagsKey, key));
    return !!result;
  }

  /** Delete tag and TTL entries for a cache key */
  async deleteTags(key: string): Promise<void> {
    await Promise.all([
      this.exec(this.client.hDel(this.sharedTagsKey, key)),
      this.exec(this.client.hDel(this.sharedTagsTtlKey, key)),
    ]);
  }

  /**
   * Check if any of the given tags have been revalidated after the given timestamp.
   * Returns true if the cache entry should be considered stale.
   */
  async isStale(tags: string[], lastModified: number): Promise<boolean> {
    if (tags.length === 0) return false;

    const times = await this.exec(
      this.client.hmGet(this.revalidatedTagsKey, tags)
    );

    for (const t of times) {
      if (t && parseInt(t, 10) > lastModified) {
        return true;
      }
    }

    return false;
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
        this.client.hSet(this.revalidatedTagsKey, tag, Date.now().toString())
      );
    }

    // Scan shared tags to find keys associated with this tag
    const keysToDelete: string[] = [];
    const tagsToDelete: string[] = [];

    let cursor = "0";
    do {
      const result = await this.exec(
        this.client.hScan(this.sharedTagsKey, cursor, { COUNT: 10000 })
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
      this.exec(this.client.unlink(keysToDelete)),
      this.exec(this.client.hDel(this.sharedTagsKey, tagsToDelete)),
      this.exec(this.client.hDel(this.sharedTagsTtlKey, tagsToDelete)),
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
        this.client.hScan(this.sharedTagsTtlKey, cursor, { COUNT: 10000 })
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
      this.exec(this.client.unlink(keysToDelete)),
      this.exec(this.client.hDel(this.sharedTagsKey, entriesToDelete)),
      this.exec(this.client.hDel(this.sharedTagsTtlKey, entriesToDelete)),
    ]);
  }

  // --- use-cache handler specific methods ---

  /**
   * Get the maximum revalidation timestamp for the given tags.
   * Returns 0 if none of the tags were ever revalidated.
   */
  async getTagExpiration(tags: string[]): Promise<number> {
    if (tags.length === 0) return 0;

    const times = await this.exec(
      this.client.hmGet(this.revalidatedTagsKey, tags)
    );

    let max = 0;
    for (const t of times) {
      if (t) {
        const ts = parseInt(t, 10);
        if (ts > max) max = ts;
      }
    }

    return max;
  }

  /**
   * Update tag timestamps for revalidation (use-cache handler).
   */
  async updateTagTimestamps(
    tags: string[],
    durations?: { expire?: number }
  ): Promise<void> {
    assertClientReady(this.client);

    const now = Date.now();

    const entries: Record<string, string> = {};
    for (const tag of tags) {
      if (durations?.expire !== undefined) {
        entries[tag] = (now + durations.expire * 1000).toString();
      } else {
        entries[tag] = now.toString();
      }
    }

    if (Object.keys(entries).length > 0) {
      await this.exec(this.client.hSet(this.revalidatedTagsKey, entries));
    }
  }
}
