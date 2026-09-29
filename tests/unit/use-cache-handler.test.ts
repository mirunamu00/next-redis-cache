// "use cache" handler behavior against an in-memory client (ROADMAP.md 5.2): Next's SWR semantics,
// implicit tags checked in get (getExpiration = Infinity), overlapping sets (7-12), tag state cache (P6).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheEvent } from "../../src/types";
import { fakeRedis } from "../support/fake-redis";
import { readEntry, useCacheEntry, useCacheHandler } from "../support/handlers";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(extra: Record<string, unknown> = {}) {
  const { fake, client } = fakeRedis();
  const events: CacheEvent[] = [];
  const { handler } = useCacheHandler({ client, onEvent: (e) => events.push(e), ...extra });
  return { fake, handler, events };
}

const T0 = 1_000_000_000;

describe("get / set", () => {
  it("round-trips the value bytes and metadata", async () => {
    const { handler } = setup();
    await handler.set("k", Promise.resolve(useCacheEntry({ value: "hello", tags: ["a"], revalidate: 10, expire: 100, stale: 5 })));
    const entry = await handler.get("k", []);
    expect(await readEntry(entry)).toBe("hello");
    expect(entry).toMatchObject({ tags: ["a"], revalidate: 10, expire: 100, stale: 5 });
  });

  it("stores the remaining lifetime as TTL", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fake, handler } = setup();
    await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0 - 20_000, revalidate: 10, expire: 100 })));
    const opts = fake.calls.find((c) => c.cmd === "set")!.args[2] as { expiration: { value: number } };
    expect(opts.expiration.value).toBe(80);
  });

  it("does not store an entry that already expired, and drops an entry marked for eviction", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fake, handler } = setup();
    await handler.set("old", Promise.resolve(useCacheEntry({ timestamp: T0 - 200_000, expire: 100 })));
    await handler.set("k", Promise.resolve(useCacheEntry()));
    await handler.set("k", Promise.resolve(useCacheEntry({ expire: -1 })));
    expect(fake.calls.map((c) => c.cmd)).toEqual(["set", "unlink"]);
    expect(await handler.get("k", [])).toBeUndefined();
  });

  it("a failed render stores nothing and reports nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, handler } = setup();
    await handler.set("k", Promise.reject(new Error("render failed")));
    expect(fake.calls).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("past revalidate the entry is still returned (SWR) until expire; swr: false misses", async () => {
    vi.useFakeTimers({ now: T0 });
    const swr = setup();
    const strict = setup({ swr: false });
    for (const { handler } of [swr, strict]) await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0, revalidate: 10, expire: 100 })));
    vi.advanceTimersByTime(11_000);
    expect(await swr.handler.get("k", [])).toBeDefined();
    expect(await strict.handler.get("k", [])).toBeUndefined();
    vi.advanceTimersByTime(90_000);
    expect(await swr.handler.get("k", [])).toBeUndefined();
  });

  it("getExpiration is Infinity (implicit tags are checked in get) and refreshTags is a no-op", async () => {
    const { fake, handler } = setup();
    expect(await handler.getExpiration(["a"])).toBe(Infinity);
    await handler.refreshTags();
    expect(fake.calls).toEqual([]);
  });
});

describe("tags", () => {
  it("updateTags(tags) expires the entry; updateTags(tags, { expire }) serves it stale", async () => {
    vi.useFakeTimers({ now: T0 });
    const a = setup();
    const b = setup();
    for (const { handler } of [a, b]) await handler.set("k", Promise.resolve(useCacheEntry({ tags: ["t"], timestamp: T0 })));
    vi.advanceTimersByTime(5);
    await a.handler.updateTags(["t"]);
    await b.handler.updateTags(["t"], { expire: 60 });
    expect(await a.handler.get("k", [])).toBeUndefined();
    expect((await b.handler.get("k", []))?.revalidate).toBe(-1);
    expect(b.events.at(-1)).toMatchObject({ type: "stale" });
  });

  it("an entry written after updateTags(tags, { expire: 1y }) is a hit (7-1)", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler } = setup();
    await handler.updateTags(["t"], { expire: 31_536_000 });
    vi.advanceTimersByTime(5);
    await handler.set("k", Promise.resolve(useCacheEntry({ value: "fresh", tags: ["t"], timestamp: Date.now() })));
    const entry = await handler.get("k", []);
    expect(entry?.revalidate).toBe(3600);
    expect(await readEntry(entry)).toBe("fresh");
  });

  it("implicit tags: an entry created at or before their latest expiry is a miss", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler } = setup();
    await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0 })));
    await handler.updateTags(["_N_T_/p"]);
    expect(await handler.get("k", ["_N_T_/p"])).toBeUndefined();
    expect(await handler.get("k", ["_N_T_/other"])).toBeDefined();
  });

  it("reads implicit tags with the entry, own tags in a second round trip only when needed", async () => {
    const { fake, handler } = setup();
    await handler.set("k", Promise.resolve(useCacheEntry({ tags: ["own"] })));
    fake.calls.length = 0;
    await handler.get("k", ["soft"]);
    expect(fake.calls.map((c) => c.cmd)).toEqual(["get", "hmGet", "hmGet"]);
    fake.calls.length = 0;
    await handler.get("k", ["soft", "own"]);
    expect(fake.calls.map((c) => c.cmd)).toEqual(["get", "hmGet"]);
  });

  it("tagStateCacheMs serves tag state from memory; local invalidations are seen at once", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fake, handler } = setup({ tagStateCacheMs: 1000 });
    await handler.set("k", Promise.resolve(useCacheEntry({ tags: ["own"], timestamp: T0 })));
    await handler.get("k", ["soft"]);
    fake.calls.length = 0;
    await handler.get("k", ["soft"]);
    expect(fake.calls.map((c) => c.cmd)).toEqual(["get"]);
    vi.advanceTimersByTime(5);
    await handler.updateTags(["own"]);
    expect(await handler.get("k", ["soft"])).toBeUndefined();
  });
});

describe("overlapping sets (7-12)", () => {
  it("get waits for the latest pending set of the key", async () => {
    const { handler } = setup();
    let resolveSecond!: (e: ReturnType<typeof useCacheEntry>) => void;
    const first = handler.set("k", Promise.resolve(useCacheEntry({ value: "first" })));
    const second = handler.set("k", new Promise((r) => (resolveSecond = r)));
    await first;
    const read = handler.get("k", []);
    setTimeout(() => resolveSecond(useCacheEntry({ value: "second" })), 20);
    expect(await readEntry(await read)).toBe("second");
    await second;
  });
});

describe("availability", () => {
  it("sends nothing while unavailable or disabled", async () => {
    const { fake, handler } = setup();
    fake.isReady = false;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await handler.get("k", ["a"])).toBeUndefined();
    await handler.set("k", Promise.resolve(useCacheEntry()));
    await handler.updateTags(["a"]);
    expect(fake.calls).toEqual([]);
    const off = setup({ disabled: true });
    await off.handler.set("k", Promise.resolve(useCacheEntry()));
    expect(await off.handler.get("k", [])).toBeUndefined();
    expect(off.fake.calls).toEqual([]);
  });

  it("rejects an invalid tagStateCacheMs", () => {
    expect(() => setup({ tagStateCacheMs: -1 })).toThrow(/tagStateCacheMs/);
  });
});
