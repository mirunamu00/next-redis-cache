// "use cache" handler details against an in-memory client: miss reasons, exact expiry boundaries, TTLs,
// the order of pending sets, tag state writes and the local tag state cache (ROADMAP.md 5.2, 7-12, P6).
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeEnvelope } from "../../src/envelope";
import { useCacheKey } from "../../src/keys";
import type { CacheEvent } from "../../src/types";
import { fakeRedis, type FakeRedis } from "../support/fake-redis";
import { readEntry, useCacheEntry, useCacheHandler } from "../support/handlers";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(extra: Record<string, unknown> = {}) {
  const { fake, client } = fakeRedis();
  const events: CacheEvent[] = [];
  const { handler, config } = useCacheHandler({ client, onEvent: (e) => events.push(e), ...extra });
  const key = (cacheKey: string) => useCacheKey(config.namespace, "b1", cacheKey);
  return { fake, handler, events, key, tagKey: `${config.namespace}:_tagstate` };
}

const T0 = 1_000_000_000;
const reasons = (events: CacheEvent[]) => events.flatMap((e) => (e.type === "miss" ? [e.reason] : []));
const ttlOf = (fake: FakeRedis) => (fake.calls.filter((c) => c.cmd === "set").at(-1)!.args[2] as { expiration: { value: number } }).expiration.value;
const meta = (m: Partial<{ tags: string[]; stale: number; timestamp: number; expire: number; revalidate: number }> = {}) => ({
  tags: [],
  stale: 0,
  timestamp: Date.now(),
  expire: 100,
  revalidate: 10,
  ...m,
});

describe("miss reasons and boundaries", () => {
  it("reports absent, format, expired, tag and unavailable as miss reasons", async () => {
    vi.useFakeTimers({ now: T0 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, handler, events, key } = setup();
    expect(await handler.get("nope", [])).toBeUndefined();
    await fake.set(key("junk"), "not an envelope");
    expect(await handler.get("junk", [])).toBeUndefined();
    await handler.set("old", Promise.resolve(useCacheEntry({ timestamp: T0, expire: 10, revalidate: 5 })));
    vi.advanceTimersByTime(10_001);
    expect(await handler.get("old", [])).toBeUndefined();
    await handler.set("t", Promise.resolve(useCacheEntry({ tags: ["x"], timestamp: Date.now() })));
    vi.advanceTimersByTime(1);
    await handler.updateTags(["x"]);
    expect(await handler.get("t", [])).toBeUndefined();
    fake.isReady = false;
    expect(await handler.get("t", [])).toBeUndefined();
    expect(reasons(events)).toEqual(["absent", "format", "expired", "tag", "unavailable"]);
    expect(events.every((e) => e.type !== "miss" || (e.handler === "use-cache" && typeof e.key === "string"))).toBe(true);
  });

  it("a disabled handler answers with a disabled miss", async () => {
    const { handler, events } = setup({ disabled: true });
    expect(await handler.get("k", [])).toBeUndefined();
    expect(events).toEqual([{ type: "miss", handler: "use-cache", key: "k", reason: "disabled" }]);
  });

  it("a failing GET is an error miss, reported with the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, handler, events } = setup();
    fake.failOn.set("get", new Error("MISCONF"));
    expect(await handler.get("k", [])).toBeUndefined();
    expect(events).toContainEqual({ type: "miss", handler: "use-cache", key: "k", reason: "error" });
    expect(events.find((e) => e.type === "error")).toMatchObject({ handler: "use-cache", op: "get", key: "k" });
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/use-cache get failed \(k\): MISCONF/);
  });

  it("an unreadable entry is logged at debug level", async () => {
    const lines: string[] = [];
    const { fake, handler, key } = setup({ logger: { debug: (m: unknown) => void lines.push(String(m)) } });
    await fake.set(key("k"), "1.x json");
    expect(await handler.get("k", [])).toBeUndefined();
    expect(lines).toEqual(["[next-redis-cache] use-cache get k: unreadable entry (not a next-redis-cache 2.x entry)"]);
  });

  it("an envelope whose value is not bytes (a legacy value under the key) is a format miss", async () => {
    const { fake, handler, events, key } = setup();
    await fake.set(key("k"), await encodeEnvelope(meta(), { kind: "APP_PAGE" }));
    expect(await handler.get("k", [])).toBeUndefined();
    expect(reasons(events)).toEqual(["format"]);
  });

  it("an entry is valid up to and including timestamp + expire", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler, events } = setup();
    await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0, revalidate: 5, expire: 10 })));
    vi.advanceTimersByTime(10_000);
    expect(await handler.get("k", [])).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(await handler.get("k", [])).toBeUndefined();
    expect(reasons(events)).toEqual(["expired"]);
  });

  it("an entry stored with expire < 0 or expire 0 is a miss", async () => {
    const { fake, handler, events, key } = setup();
    await fake.set(key("m"), await encodeEnvelope(meta({ expire: -1 }), Buffer.from("v")));
    await fake.set(key("z"), await encodeEnvelope(meta({ expire: 0, timestamp: Date.now() - 1 }), Buffer.from("v")));
    expect(await handler.get("m", [])).toBeUndefined();
    expect(await handler.get("z", [])).toBeUndefined();
    expect(reasons(events)).toEqual(["expired", "expired"]);
  });

  it("swr: false serves up to and including timestamp + revalidate", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler, events } = setup({ swr: false });
    await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0, revalidate: 10, expire: 100 })));
    vi.advanceTimersByTime(10_000);
    expect(await handler.get("k", [])).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(await handler.get("k", [])).toBeUndefined();
    expect(reasons(events)).toEqual(["expired"]);
  });

  it("a hit emits a hit event and returns the stored metadata as it is", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler, events } = setup();
    await handler.set("k", Promise.resolve(useCacheEntry({ tags: ["a", "a", "b"], timestamp: T0 - 5, revalidate: 7, expire: 70, stale: 3 })));
    const entry = await handler.get("k", []);
    expect(entry).toMatchObject({ tags: ["a", "a", "b"], stale: 3, timestamp: T0 - 5, expire: 70, revalidate: 7 });
    expect(events.at(-1)).toEqual({ type: "hit", handler: "use-cache", key: "k" });
  });

  it("a stale own tag emits a stale event with reason tag", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler, events } = setup();
    await handler.set("k", Promise.resolve(useCacheEntry({ tags: ["t"], timestamp: T0 })));
    vi.advanceTimersByTime(1);
    await handler.updateTags(["t"], { expire: 60 });
    expect((await handler.get("k", []))?.revalidate).toBe(-1);
    expect(events.at(-1)).toEqual({ type: "stale", handler: "use-cache", key: "k", reason: "tag" });
  });

  it("an own tag marked stale before the entry was written does not make it stale", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler, events } = setup();
    await handler.updateTags(["t"], { expire: 60 });
    vi.advanceTimersByTime(1);
    await handler.set("k", Promise.resolve(useCacheEntry({ tags: ["t"], timestamp: Date.now() })));
    expect((await handler.get("k", []))?.revalidate).toBe(3600);
    expect(events.at(-1)).toMatchObject({ type: "hit" });
  });

  it("an implicit tag expired strictly before the entry was created keeps it; at the same millisecond it is a miss", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler, events } = setup();
    await handler.updateTags(["_N_T_/p"]);
    await handler.set("same", Promise.resolve(useCacheEntry({ timestamp: Date.now() })));
    vi.advanceTimersByTime(1);
    await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: Date.now() })));
    expect(await handler.get("k", ["_N_T_/p"])).toBeDefined();
    expect(await handler.get("same", ["_N_T_/p"])).toBeUndefined();
    expect(reasons(events)).toEqual(["tag"]);
  });

  it("empty and duplicate soft tags are not sent", async () => {
    const { fake, handler } = setup();
    await handler.set("k", Promise.resolve(useCacheEntry()));
    fake.calls.length = 0;
    await handler.get("k", ["", "s", "s"]);
    expect(fake.calls.filter((c) => c.cmd === "hmGet").map((c) => c.args[1])).toEqual([["s:s", "x:s"]]);
    fake.calls.length = 0;
    await handler.get("k", ["", ""]);
    expect(fake.calls.map((c) => c.cmd)).toEqual(["get"]);
    fake.calls.length = 0;
    await handler.get("k", undefined as unknown as string[]);
    expect(fake.calls.map((c) => c.cmd)).toEqual(["get"]);
  });

  it("reads the entry's unique, non-empty own tags; a failed read serves the entry as it is", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, handler, events, tagKey } = setup();
    await handler.set("k", Promise.resolve(useCacheEntry({ value: "v", tags: ["own", "own", ""] })));
    fake.calls.length = 0;
    await handler.get("k", []);
    expect(fake.calls[1]).toEqual({ cmd: "hmGet", args: [tagKey, ["s:own", "x:own"]] });
    fake.failOn.set("hmGet", new Error("LOADING"));
    expect(await readEntry(await handler.get("k", []))).toBe("v");
    expect(events.at(-1)).toMatchObject({ type: "hit" });
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/use-cache get failed \(k\): LOADING/);
  });
});

describe("set details", () => {
  it("with swr: false the TTL follows revalidate, not expire", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fake, handler } = setup({ swr: false });
    await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0, revalidate: 10, expire: 100 })));
    expect(ttlOf(fake)).toBe(11);
    await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0, revalidate: 100, expire: 20 })));
    expect(ttlOf(fake)).toBe(21);
  });

  it("with swr: false an entry past revalidate is not stored", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fake, handler } = setup({ swr: false });
    await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0 - 11_000, revalidate: 10, expire: 100 })));
    expect(fake.calls).toEqual([]);
  });

  it("rounds a partial second up, adds one second and caps at ttl.maxSeconds (at least 1)", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fake, handler } = setup();
    await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0 - 500, expire: 10 })));
    expect(ttlOf(fake)).toBe(11); // 9.5 s -> 10 s + 1 s
    await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0 - 9_999, expire: 10 })));
    expect(ttlOf(fake)).toBe(2); // 1 ms left -> 1 s + 1 s
    const capped = setup({ ttl: { maxSeconds: 30 } });
    await capped.handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0, expire: 100 })));
    expect(ttlOf(capped.fake)).toBe(30);
    const tiny = setup({ ttl: { maxSeconds: 0.5 } });
    await tiny.handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0, expire: 100 })));
    expect(ttlOf(tiny.fake)).toBe(1);
  });

  it("an entry with expire 0 is not stored and not treated as an eviction mark", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fake, handler } = setup();
    await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0, expire: 0 })));
    expect(fake.calls).toEqual([]);
  });

  it("a get after a failed render does not wait for it", async () => {
    const { handler } = setup();
    await handler.set("k", Promise.reject(new Error("render failed")));
    let done = false;
    const read = handler.get("k", []).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(true);
    await read;
  });

  it("reads time out after timeouts.readMs (entry, implicit and own tags), writes use timeouts.writeMs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, handler } = setup({ timeouts: { readMs: 50, writeMs: 10_000 } });
    await handler.set("k", Promise.resolve(useCacheEntry({ tags: ["own"] })));
    const hmGet = fake.hmGet.bind(fake);
    fake.hmGet = () => new Promise(() => {}) as never; // only the own-tag read hangs
    let t0 = Date.now();
    expect(await handler.get("k", [])).toBeDefined(); // served as it is
    expect(Date.now() - t0).toBeLessThan(2000);
    fake.hmGet = hmGet;
    fake.hanging = true;
    t0 = Date.now();
    expect(await handler.get("k", ["soft"])).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2000);
    const slow = setup({ timeouts: { readMs: 10_000, writeMs: 50 } });
    slow.fake.hanging = true;
    t0 = Date.now();
    await slow.handler.set("k", Promise.resolve(useCacheEntry()));
    await slow.handler.set("k", Promise.resolve(useCacheEntry({ expire: -1 })));
    await slow.handler.updateTags(["t"]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("an entry whose lifetime ended exactly now is not stored", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fake, handler, events } = setup();
    await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0 - 10_000, expire: 10 })));
    expect(fake.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it("stores the value bytes and metadata; missing tags become an empty list; emits the stored size", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fake, handler, events, key } = setup({ compression: "none" });
    await handler.set("k", Promise.resolve({ ...useCacheEntry({ value: "abc", revalidate: 9, expire: 99, stale: 4 }), tags: undefined as unknown as string[] }));
    const set = fake.calls.find((c) => c.cmd === "set")!;
    expect(set.args[0]).toBe(key("k"));
    const { decodeEnvelope } = await import("../../src/envelope");
    const stored = await decodeEnvelope<Record<string, unknown>>(set.args[1] as Buffer);
    expect(stored.meta).toEqual({ tags: [], stale: 4, timestamp: T0, expire: 99, revalidate: 9 });
    expect(stored.value).toEqual(Buffer.from("abc"));
    expect(events).toEqual([{ type: "set", handler: "use-cache", key: "k", bytes: (set.args[1] as Buffer).byteLength }]);
  });

  it("does not read the value stream while Redis is unavailable, and stores nothing while disabled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, handler } = setup();
    fake.isReady = false;
    let pulled = false;
    // highWaterMark 0: pull() only runs when the stream is read
    const value = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulled = true;
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    await handler.set("k", Promise.resolve({ ...useCacheEntry(), value }));
    expect(pulled).toBe(false);
    const off = setup({ disabled: true });
    await off.handler.set("k", Promise.resolve(useCacheEntry({ expire: -1 })));
    expect(off.fake.calls).toEqual([]);
    expect(await off.handler.get("k", [])).toBeUndefined(); // not blocked by the finished set
  });

  it("an eviction mark is one UNLINK of the entry key, and a failed UNLINK is reported", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, handler, key } = setup();
    await handler.set("k", Promise.resolve(useCacheEntry({ expire: -1 })));
    expect(fake.calls).toEqual([{ cmd: "unlink", args: [[key("k")]] }]);
    fake.failOn.set("unlink", new Error("READONLY"));
    await handler.set("k", Promise.resolve(useCacheEntry({ expire: -1 })));
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/use-cache set failed \(k\): READONLY/);
  });

  it("the first successful round trip after a failure logs the recovery once (get, set, eviction, updateTags)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { fake, handler } = setup();
    const fail = async (cmd: string, op: () => Promise<unknown>) => {
      fake.failOn.set(cmd, new Error("down"));
      await op();
      fake.failOn.clear();
    };
    await fail("set", () => handler.set("k", Promise.resolve(useCacheEntry())));
    await handler.set("k", Promise.resolve(useCacheEntry({ expire: -1 })));
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/use-cache recovered/);
    await fail("unlink", () => handler.set("k", Promise.resolve(useCacheEntry({ expire: -1 }))));
    await handler.set("k", Promise.resolve(useCacheEntry()));
    expect(info).toHaveBeenCalledTimes(2);
    await fail("set", () => handler.set("k", Promise.resolve(useCacheEntry())));
    await handler.get("k", []);
    expect(info).toHaveBeenCalledTimes(3);
    await fail("set", () => handler.set("k", Promise.resolve(useCacheEntry())));
    await handler.updateTags(["a"]);
    expect(info).toHaveBeenCalledTimes(4);
  });

  it("a get waits for the newest pending set; a failed older render does not release it", async () => {
    const { handler } = setup();
    let failFirst!: (e: Error) => void;
    let resolveSecond!: (e: ReturnType<typeof useCacheEntry>) => void;
    const first = handler.set("k", new Promise((_, reject) => (failFirst = reject)));
    const second = handler.set("k", new Promise((r) => (resolveSecond = r)));
    failFirst(new Error("render failed"));
    await first;
    let done = false;
    const read = handler.get("k", []).then((e) => {
      done = true;
      return e;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    resolveSecond(useCacheEntry({ value: "second" }));
    await second;
    expect(await readEntry(await read)).toBe("second");
  });

  it("an older set that finishes last does not release the newer pending set", async () => {
    const { handler } = setup();
    let resolveFirst!: (e: ReturnType<typeof useCacheEntry>) => void;
    let resolveSecond!: (e: ReturnType<typeof useCacheEntry>) => void;
    const first = handler.set("k", new Promise((r) => (resolveFirst = r)));
    const second = handler.set("k", new Promise((r) => (resolveSecond = r)));
    resolveFirst(useCacheEntry({ value: "first" }));
    await first;
    let done = false;
    const read = handler.get("k", []).then((e) => {
      done = true;
      return e;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    resolveSecond(useCacheEntry({ value: "second" }));
    await second;
    expect(await readEntry(await read)).toBe("second");
  });

  it("a get is not blocked by a pending set of another key or by a finished set", async () => {
    const { handler } = setup();
    void handler.set("other", new Promise(() => {}));
    await handler.set("k", Promise.resolve(useCacheEntry({ value: "k" })));
    expect(await readEntry(await handler.get("k", []))).toBe("k");
    expect(await readEntry(await handler.get("k", []))).toBe("k");
  });
});

describe("updateTags details", () => {
  it("sends one HSET for the unique, non-empty tags and passes durations through", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fake, handler, tagKey } = setup();
    await handler.updateTags(["a", "", "a", "b"], { expire: 5 });
    expect(fake.calls).toEqual([{ cmd: "hSet", args: [tagKey, { "s:a": String(T0), "x:a": String(T0 + 5000), "s:b": String(T0), "x:b": String(T0 + 5000) }] }]);
    await handler.updateTags(["", ""]);
    await handler.updateTags(undefined as unknown as string[]);
    expect(fake.calls).toHaveLength(1);
  });

  it("does nothing while disabled; a failed HSET is reported with the tag list", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const off = setup({ disabled: true });
    await off.handler.updateTags(["a"]);
    expect(off.fake.calls).toEqual([]);
    const { fake, handler, events } = setup();
    fake.failOn.set("hSet", new Error("READONLY"));
    await handler.updateTags(["a", "b"]);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/use-cache updateTags failed \(a,b\): READONLY/);
    expect(events.find((e) => e.type === "error")).toMatchObject({ handler: "use-cache", op: "updateTags", key: "a,b" });
  });

  it("a failed updateTags still drops the local tag state cache", async () => {
    vi.useFakeTimers({ now: T0 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { fake, handler, tagKey } = setup({ tagStateCacheMs: 60_000 });
    await handler.set("k", Promise.resolve(useCacheEntry({ tags: ["own"], timestamp: T0 })));
    expect(await handler.get("k", [])).toBeDefined(); // caches "own"
    vi.advanceTimersByTime(5);
    await fake.hSet(tagKey, { "x:own": String(Date.now()) }); // another instance invalidated it
    expect(await handler.get("k", [])).toBeDefined(); // still the cached state
    fake.failOn.set("hSet", new Error("READONLY"));
    await handler.updateTags(["own"]);
    fake.failOn.clear();
    expect(await handler.get("k", [])).toBeUndefined();
  });

  it("tagStateCacheMs: soft tags are cached too, until the cache time has passed", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fake, handler, tagKey } = setup({ tagStateCacheMs: 1000 });
    await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: T0 })));
    await handler.get("k", ["soft"]);
    vi.advanceTimersByTime(5);
    await fake.hSet(tagKey, { "x:soft": String(Date.now()) });
    fake.calls.length = 0;
    expect(await handler.get("k", ["soft"])).toBeDefined(); // served from the cached tag state
    expect(fake.calls.map((c) => c.cmd)).toEqual(["get"]);
    vi.advanceTimersByTime(995);
    expect(await handler.get("k", ["soft"])).toBeUndefined();
  });

  it("without tagStateCacheMs every get reads the tag state", async () => {
    const { fake, handler } = setup();
    await handler.set("k", Promise.resolve(useCacheEntry({ tags: ["own"] })));
    fake.calls.length = 0;
    await handler.get("k", ["soft"]);
    await handler.get("k", ["soft"]);
    expect(fake.calls.map((c) => c.cmd)).toEqual(["get", "hmGet", "hmGet", "get", "hmGet", "hmGet"]);
  });

  it("rejects NaN, Infinity and non-numbers as tagStateCacheMs; 0 is allowed", () => {
    expect(() => setup({ tagStateCacheMs: Number.NaN })).toThrow("[next-redis-cache] tagStateCacheMs must be a number >= 0, got NaN");
    expect(() => setup({ tagStateCacheMs: Infinity })).toThrow(/got Infinity/);
    expect(() => setup({ tagStateCacheMs: "5" })).toThrow(/got 5/);
    expect(() => setup({ tagStateCacheMs: 0 })).not.toThrow();
  });
});
