// contract-oracle (ROADMAP.md section 6.5): random operation sequences are applied to Next's own
// default "use cache" handler (the reference) and to ours (backed by mini-redis); the outcome Next's
// use-cache wrapper would derive from each `get` must match.
//
// Outcome model (next/dist/server/use-cache/use-cache-wrapper.js, Next 16):
//   entry = handler.get(key, softTags); none -> "miss"
//   exp = handler.getExpiration(softTags) (Infinity -> 0); entry.timestamp <= exp -> "miss"
//   entry.revalidate === -1 -> "stale:<value>" (served, regenerated in the background), else "hit:<value>"
// Time is virtual: Date.now and performance.now are driven by the test, so both handlers (and
// mini-redis expiry) see the same clock.
import { createRequire } from "node:module";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@redis/client";
import type { CacheHandler } from "next/dist/server/lib/cache-handlers/types";
import { startMiniRedis, type MiniRedis } from "../../support/mini-redis";
import { uniqueNamespace } from "../../support/namespace";
import { readEntry, useCacheEntry } from "../../support/handlers";
import { createUseCacheHandler } from "../../../src/use-cache-handler";

const require = createRequire(import.meta.url);
const { createDefaultCacheHandler } = require("next/dist/server/lib/cache-handlers/default.js") as {
  createDefaultCacheHandler: (maxSize: number) => CacheHandler;
};
const { tagsManifest } = require("next/dist/server/lib/incremental-cache/tags-manifest.external.js") as {
  tagsManifest: Map<string, unknown>;
};

const KEYS = ["k0", "k1", "k2"];
const TAGS = ["t0", "t1", "t2"];

type Op =
  | { op: "set"; key: string; tags: string[]; revalidate: number; expireFactor: number }
  | { op: "get"; key: string; softTags: string[] }
  | { op: "updateTags"; tags: string[]; expire: number | undefined }
  | { op: "advance"; ms: number };

const tagSubset = fc.subarray(TAGS);
const setOp = fc.record({
  op: fc.constant("set" as const),
  key: fc.constantFrom(...KEYS),
  tags: tagSubset,
  revalidate: fc.constantFrom(1, 10, 100),
  expireFactor: fc.constantFrom(1, 2, 10),
});
const getOp = fc.record({ op: fc.constant("get" as const), key: fc.constantFrom(...KEYS), softTags: tagSubset });
const advanceOp = fc.record({ op: fc.constant("advance" as const), ms: fc.integer({ min: 1, max: 20_000 }) });
const updateOp = (withDurations: boolean) =>
  fc.record({
    op: fc.constant("updateTags" as const),
    tags: fc.subarray(TAGS, { minLength: 1 }),
    expire: withDurations ? fc.constantFrom(0, 5, 60, 31_536_000) : fc.constant(undefined),
  });
// With durations, stale answers need set -> (time passes) -> updateTags on one of its tags -> get of that key;
// random programs rarely produce that order, so it is also generated as one chunk.
const staleScenario = fc
  .tuple(setOp, fc.integer({ min: 1, max: 2000 }), updateOp(true), fc.subarray(TAGS))
  .map(([set, ms, update, softTags]): Op[] => [
    set,
    { op: "advance", ms },
    { ...update, tags: set.tags.length > 0 ? set.tags : update.tags },
    { op: "get", key: set.key, softTags },
  ]);
const program = (withDurations: boolean) =>
  withDurations
    ? fc
        .array(fc.oneof(setOp.map((o): Op[] => [o]), getOp.map((o): Op[] => [o]), advanceOp.map((o): Op[] => [o]), updateOp(true).map((o): Op[] => [o]), staleScenario), {
          minLength: 2,
          maxLength: 12,
        })
        .map((chunks) => chunks.flat())
    : fc.array(fc.oneof(setOp, getOp, getOp, advanceOp, updateOp(false)), { minLength: 4, maxLength: 24 });

let clock = 0;
let redis: MiniRedis;
let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  redis = await startMiniRedis();
  client = createClient({ url: redis.url, socket: { reconnectStrategy: false } });
  client.on("error", () => {});
  await client.connect();
});

afterAll(async () => {
  client?.destroy();
  await redis?.stop();
});

beforeEach(() => {
  clock = Math.floor(Date.now());
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(performance, "now").mockImplementation(() => clock - performance.timeOrigin);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function outcome(handler: CacheHandler, key: string, softTags: string[]): Promise<string> {
  const entry = await handler.get(key, softTags);
  if (!entry) return "miss";
  let exp = await handler.getExpiration(softTags);
  if (exp === Infinity) exp = 0;
  const value = await readEntry(entry);
  if (entry.timestamp <= exp) return "miss";
  return `${entry.revalidate === -1 ? "stale" : "hit"}:${value}`;
}

async function execute(ops: Op[], handler: CacheHandler): Promise<string[]> {
  const results: string[] = [];
  let n = 0;
  for (const o of ops) {
    switch (o.op) {
      case "set":
        n += 1;
        await handler.set(
          o.key,
          Promise.resolve(useCacheEntry({ value: `v${n}`, tags: o.tags, timestamp: clock, revalidate: o.revalidate, expire: o.revalidate * o.expireFactor })),
        );
        break;
      case "get":
        results.push(`${o.key}=${await outcome(handler, o.key, o.softTags)}`);
        break;
      case "updateTags":
        await handler.updateTags(o.tags, o.expire === undefined ? undefined : { expire: o.expire });
        break;
      case "advance":
        clock += o.ms;
        break;
    }
  }
  return results;
}

/** Runs the same program on the reference and on ours, from the same start time. */
async function differential(ops: Op[]): Promise<{ reference: string[]; ours: string[] }> {
  const start = clock;
  tagsManifest.clear();
  const reference = await execute(ops, createDefaultCacheHandler(50 * 1024 * 1024));
  clock = start;
  // swr: false = the production behavior of Next's in-memory default handler (drops entries past revalidate)
  const ours = await execute(
    ops,
    createUseCacheHandler({ client: client as never, namespace: uniqueNamespace(), buildId: "b", swr: false, disabled: false }) as CacheHandler,
  );
  return { reference, ours };
}

describe("use-cache handler vs Next's default handler", () => {
  // Random programs reach an exact boundary only rarely (a flaky mismatch): pin them. At ts + revalidate the
  // entry is still a hit for Next, so the Redis key must not expire at that same millisecond.
  it("agrees exactly at the revalidate and expire boundaries", async () => {
    const ops: Op[] = [
      { op: "set", key: "k0", tags: [], revalidate: 1, expireFactor: 1 },
      { op: "set", key: "k1", tags: [], revalidate: 10, expireFactor: 2 },
      { op: "advance", ms: 1_000 },
      { op: "get", key: "k0", softTags: [] },
      { op: "advance", ms: 1 },
      { op: "get", key: "k0", softTags: [] },
      { op: "advance", ms: 8_999 },
      { op: "get", key: "k1", softTags: [] },
      { op: "advance", ms: 1 },
      { op: "get", key: "k1", softTags: [] },
    ];
    const { reference, ours } = await differential(ops);
    expect(reference).toEqual(["k0=hit:v1", "k0=miss", "k1=hit:v2", "k1=miss"]);
    expect(ours).toEqual(reference);
  });

  it("agrees on hits and misses when tags are expired immediately (updateTags without durations)", async () => {
    const seen = { hit: 0, miss: 0 };
    await fc.assert(
      fc.asyncProperty(program(false), async (ops) => {
        const { reference, ours } = await differential(ops);
        expect(ours).toEqual(reference);
        for (const r of reference) seen[r.includes("=hit:") ? "hit" : "miss"] += 1;
      }),
      { numRuns: 60 },
    );
    // The generated programs must exercise both outcomes, or the comparison proves little
    expect(seen.hit).toBeGreaterThan(10);
    expect(seen.miss).toBeGreaterThan(10);
  });

  // Fixed in 2.0 (7-1): the shared tag state keeps Next's stale and expired time per tag, so an older entry
  // is served stale once (revalidate -1), and implicit tags follow the wrapper's getExpiration rule inside get().
  // The fixed program always shows the difference 1.x had (reference k0=stale:v1, 1.x k0=miss).
  it("[7-1] agrees when tags are revalidated with durations (revalidateTag(tag, profile))", async () => {
    const ops: Op[] = [
      { op: "set", key: "k0", tags: ["t0"], revalidate: 100, expireFactor: 10 },
      { op: "advance", ms: 1_000 },
      { op: "updateTags", tags: ["t0"], expire: 60 },
      { op: "get", key: "k0", softTags: [] },
    ];
    const { reference, ours } = await differential(ops);
    expect(reference).toEqual(["k0=stale:v1"]);
    expect(ours).toEqual(reference);
  });

  it("agrees on random programs with durations (revalidateTag(tag, profile))", async () => {
    let stale = 0;
    await fc.assert(
      fc.asyncProperty(program(true), async (ops) => {
        const { reference, ours } = await differential(ops);
        expect(ours).toEqual(reference);
        stale += reference.filter((r) => r.includes("=stale:")).length;
      }),
      { numRuns: 60 },
    );
    // Stale-while-revalidate answers must actually occur, or the comparison proves little
    expect(stale).toBeGreaterThan(3);
  });
});
