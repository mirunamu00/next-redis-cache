/**
 * Tag state shared by both handlers and every build of a namespace (ROADMAP.md sections 5.1, 5.2).
 *
 * One hash `{namespace}:_tagstate` holds two fields per tag, both epoch milliseconds:
 *   "s:<tag>"  stale    - entries created before it are served stale (SWR) and regenerated
 *   "x:<tag>"  expired  - entries created before it are expired once it is in the past
 * The semantics are Next.js' own (tags-manifest.external `areTagsExpired` / `areTagsStale`, the
 * default handler's `updateTags`):
 *   updateTags(tags)             x = now                       (immediate expiry: updateTag, revalidatePath)
 *   updateTags(tags, {expire})   s = now, x = now + expire*1000 (revalidateTag(tag, profile): stale now,
 *                                                               expired after the profile's expire)
 * Two fields instead of one "stale,expired" value keep every update a single idempotent HSET that
 * leaves the other field untouched, exactly like Next's partial updates (decision D21).
 * There is no tag -> key index: invalidation is lazy, entries are checked when read (Q5).
 */
export interface TagTimes {
  /** 0 = never marked stale */
  stale: number;
  /** 0 = never expired */
  expired: number;
}

export type TagTable = Map<string, TagTimes>;

export const staleField = (tag: string) => `s:${tag}`;
export const expiredField = (tag: string) => `x:${tag}`;

/** HMGET fields for `tags`: [s:t0, x:t0, s:t1, x:t1, ...]. */
export function tagFields(tags: readonly string[]): string[] {
  const fields: string[] = [];
  for (const t of tags) fields.push(staleField(t), expiredField(t));
  return fields;
}

function toTime(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const n = Number(String(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Parses an HMGET reply for `tags` (see tagFields) into `into`. */
export function parseTagFields(tags: readonly string[], reply: readonly unknown[], into: TagTable = new Map()): TagTable {
  tags.forEach((tag, i) => {
    into.set(tag, { stale: toTime(reply[2 * i]), expired: toTime(reply[2 * i + 1]) });
  });
  return into;
}

/** HSET fields recording an invalidation of `tags` at `now`. */
export function updateFields(tags: readonly string[], durations: { expire?: number } | undefined, now: number): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const tag of tags) {
    if (durations) {
      fields[staleField(tag)] = String(now);
      if (typeof durations.expire === "number" && Number.isFinite(durations.expire)) {
        fields[expiredField(tag)] = String(now + Math.max(0, durations.expire) * 1000);
      }
    } else {
      fields[expiredField(tag)] = String(now);
    }
  }
  return fields;
}

/** Next.js areTagsExpired: some tag expired after the entry was created, and that time has passed. */
export function areTagsExpired(tags: Iterable<string>, table: TagTable, timestamp: number, now: number): boolean {
  for (const tag of tags) {
    const expired = table.get(tag)?.expired ?? 0;
    if (expired > 0 && expired <= now && expired > timestamp) return true;
  }
  return false;
}

/** Next.js areTagsStale: some tag was marked stale after the entry was created. */
export function areTagsStale(tags: Iterable<string>, table: TagTable, timestamp: number): boolean {
  for (const tag of tags) {
    if ((table.get(tag)?.stale ?? 0) > timestamp) return true;
  }
  return false;
}

/**
 * The implicit-tag rule of Next's "use cache" wrapper: an entry is discarded when it was created at
 * or before the latest expiration of any implicit (soft) tag - the value the default handler's
 * `getExpiration` returns. The package returns Infinity from getExpiration and applies this rule
 * itself in `get(softTags)`, so the tags are read once, in the same round trip as the entry.
 */
export function softTagsDiscard(softTags: Iterable<string>, table: TagTable, timestamp: number): boolean {
  let latest = 0;
  for (const tag of softTags) latest = Math.max(latest, table.get(tag)?.expired ?? 0);
  return latest > 0 && timestamp <= latest;
}

/** Tags of `wanted` that are not in `table` yet. */
export function missingTags(wanted: Iterable<string>, table: TagTable): string[] {
  const out: string[] = [];
  for (const t of wanted) if (!table.has(t) && !out.includes(t)) out.push(t);
  return out;
}

/**
 * Optional in-process cache of tag state (`tagStateCacheMs`, P6). Entries live for `ttlMs`; an
 * invalidation made by this process updates the cache immediately.
 */
export class TagStateCache {
  readonly #ttlMs: number;
  readonly #entries = new Map<string, { times: TagTimes; at: number }>();
  static readonly MAX_ENTRIES = 10_000;

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  get enabled(): boolean {
    return this.#ttlMs > 0;
  }

  /** Fills `into` with fresh cached tags and returns the tags still to be read. */
  lookup(tags: readonly string[], into: TagTable, now: number): string[] {
    if (!this.enabled) return [...tags];
    const rest: string[] = [];
    for (const tag of tags) {
      const hit = this.#entries.get(tag);
      if (hit && now - hit.at < this.#ttlMs) into.set(tag, hit.times);
      else rest.push(tag);
    }
    return rest;
  }

  store(table: TagTable, tags: readonly string[], now: number): void {
    if (!this.enabled) return;
    for (const tag of tags) {
      const times = table.get(tag);
      if (!times) continue;
      if (this.#entries.size >= TagStateCache.MAX_ENTRIES) {
        const oldest = this.#entries.keys().next().value;
        if (oldest !== undefined) this.#entries.delete(oldest);
      }
      this.#entries.delete(tag);
      this.#entries.set(tag, { times, at: now });
    }
  }

  /** Drops `tags` so the next read goes to Redis (called after this process invalidated them). */
  invalidate(tags: readonly string[]): void {
    for (const tag of tags) this.#entries.delete(tag);
  }

  clear(): void {
    this.#entries.clear();
  }
}
