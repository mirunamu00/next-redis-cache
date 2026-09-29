// Tag state semantics (ROADMAP.md 5.2): Next's areTagsExpired / areTagsStale and the default handler's
// updateTags, stored as two hash fields per tag.
import { describe, expect, it } from "vitest";
import {
  areTagsExpired,
  areTagsStale,
  missingTags,
  parseTagFields,
  softTagsDiscard,
  tagFields,
  TagStateCache,
  updateFields,
  type TagTable,
} from "../../src/tag-state";

const table = (entries: Record<string, [stale: number, expired: number]>): TagTable =>
  new Map(Object.entries(entries).map(([t, [stale, expired]]) => [t, { stale, expired }]));

describe("fields", () => {
  it("reads and writes two fields per tag", () => {
    expect(tagFields(["a", "b"])).toEqual(["s:a", "x:a", "s:b", "x:b"]);
    const parsed = parseTagFields(["a", "b"], ["10", null, "garbage", "30"]);
    expect(parsed.get("a")).toEqual({ stale: 10, expired: 0 });
    expect(parsed.get("b")).toEqual({ stale: 0, expired: 30 });
  });

  it("updateTags without durations expires now and leaves stale alone", () => {
    expect(updateFields(["a"], undefined, 100)).toEqual({ "x:a": "100" });
  });

  it("updateTags with durations marks stale now and expired after the profile", () => {
    expect(updateFields(["a", "b"], { expire: 60 }, 100)).toEqual({ "s:a": "100", "x:a": "60100", "s:b": "100", "x:b": "60100" });
    expect(updateFields(["a"], {}, 100)).toEqual({ "s:a": "100" });
    expect(updateFields(["a"], { expire: 0 }, 100)).toEqual({ "s:a": "100", "x:a": "100" });
  });
});

describe("checks", () => {
  it("areTagsExpired: expired after the entry and already in the past", () => {
    const t = table({ a: [0, 100] });
    expect(areTagsExpired(["a"], t, 50, 200)).toBe(true);
    expect(areTagsExpired(["a"], t, 100, 200)).toBe(false); // created at the same ms
    expect(areTagsExpired(["a"], t, 150, 200)).toBe(false); // created afterwards
    expect(areTagsExpired(["a"], t, 50, 99)).toBe(false); // expiry still in the future
    expect(areTagsExpired(["unknown"], t, 50, 200)).toBe(false);
  });

  it("areTagsStale: marked stale after the entry", () => {
    const t = table({ a: [100, 0] });
    expect(areTagsStale(["a"], t, 50)).toBe(true);
    expect(areTagsStale(["a"], t, 100)).toBe(false);
  });

  it("softTagsDiscard: created at or before the latest implicit-tag expiry (future ones included)", () => {
    const t = table({ a: [0, 100], b: [0, 500] });
    expect(softTagsDiscard(["a"], t, 100)).toBe(true);
    expect(softTagsDiscard(["a"], t, 101)).toBe(false);
    expect(softTagsDiscard(["a", "b"], t, 400)).toBe(true);
    expect(softTagsDiscard([], t, 1)).toBe(false);
  });

  it("missingTags lists each unknown tag once", () => {
    expect(missingTags(["a", "b", "b", "c"], table({ a: [0, 0] }))).toEqual(["b", "c"]);
  });
});

describe("TagStateCache", () => {
  it("is a pass-through when disabled", () => {
    const c = new TagStateCache(0);
    const into: TagTable = new Map();
    c.store(table({ a: [1, 1] }), ["a"], 0);
    expect(c.lookup(["a"], into, 0)).toEqual(["a"]);
  });

  it("serves fresh entries, expires them after ttl, drops invalidated tags", () => {
    const c = new TagStateCache(1000);
    c.store(table({ a: [1, 2], b: [3, 4] }), ["a", "b"], 0);
    const into: TagTable = new Map();
    expect(c.lookup(["a", "b", "c"], into, 500)).toEqual(["c"]);
    expect(into.get("a")).toEqual({ stale: 1, expired: 2 });
    c.invalidate(["a"]);
    expect(c.lookup(["a", "b"], new Map(), 500)).toEqual(["a"]);
    expect(c.lookup(["b"], new Map(), 1000)).toEqual(["b"]);
  });
});
