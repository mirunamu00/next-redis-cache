// Tag checks equal Next.js' reference implementation (tags-manifest.external areTagsExpired / areTagsStale,
// default handler updateTags) for random update sequences - ROADMAP.md 6.5 property layer.
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { areTagsExpired, areTagsStale, parseTagFields, tagFields, updateFields, type TagTable } from "../../src/tag-state";
import { ttlSeconds } from "../../src/ttl";
import { resolveConfig } from "../../src/config";

const require = createRequire(import.meta.url);
const reference = require("next/dist/server/lib/incremental-cache/tags-manifest.external.js") as {
  tagsManifest: Map<string, { stale?: number; expired?: number }>;
  areTagsExpired: (tags: string[], ts: number) => boolean;
  areTagsStale: (tags: string[], ts: number) => boolean;
};

afterEach(() => {
  vi.restoreAllMocks();
  reference.tagsManifest.clear();
});

const TAGS = ["a", "b", "c"];
const update = fc.record({
  tags: fc.subarray(TAGS, { minLength: 1 }),
  at: fc.integer({ min: 0, max: 1000 }),
  expire: fc.option(fc.constantFrom(0, 1, 5, 60), { nil: undefined }),
  durations: fc.boolean(),
});

describe("tag state vs Next's tags manifest", () => {
  it("areTagsExpired and areTagsStale agree for every entry timestamp and read time", () => {
    fc.assert(
      fc.property(fc.array(update, { maxLength: 8 }), fc.integer({ min: 0, max: 2000 }), fc.integer({ min: 0, max: 200_000 }), fc.subarray(TAGS), (updates, ts, now, tags) => {
        reference.tagsManifest.clear();
        const hash = new Map<string, string>();
        const sorted = [...updates].sort((x, y) => x.at - y.at);
        for (const u of sorted) {
          const durations = u.durations ? { expire: u.expire } : undefined;
          // reference: the default handler's updateTags
          for (const tag of u.tags) {
            const existing = reference.tagsManifest.get(tag) ?? {};
            if (durations) {
              const next = { ...existing, stale: u.at };
              if (durations.expire !== undefined) next.expired = u.at + durations.expire * 1000;
              reference.tagsManifest.set(tag, next);
            } else reference.tagsManifest.set(tag, { ...existing, expired: u.at });
          }
          for (const [f, v] of Object.entries(updateFields(u.tags, durations, u.at))) hash.set(f, v);
        }
        const table: TagTable = parseTagFields(tags, tagFields(tags).map((f) => hash.get(f) ?? null));
        vi.spyOn(Date, "now").mockReturnValue(now);
        vi.spyOn(performance, "now").mockReturnValue(now - performance.timeOrigin);
        expect(areTagsExpired(tags, table, ts, now)).toBe(reference.areTagsExpired(tags, ts));
        expect(areTagsStale(tags, table, ts)).toBe(reference.areTagsStale(tags, ts));
        vi.restoreAllMocks();
      }),
      { numRuns: 500 },
    );
  });
});

describe("TTL policy", () => {
  const cfg = resolveConfig({ client: null, namespace: "p" });
  it("is monotonic in revalidate, at least 1s and capped at maxSeconds", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000_000 }), fc.integer({ min: 1, max: 100_000_000 }), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(ttlSeconds(cfg, lo)).toBeLessThanOrEqual(ttlSeconds(cfg, hi));
        expect(ttlSeconds(cfg, hi)).toBeLessThanOrEqual(cfg.maxSeconds);
        expect(ttlSeconds(cfg, lo)).toBeGreaterThanOrEqual(1);
      }),
    );
  });
});
