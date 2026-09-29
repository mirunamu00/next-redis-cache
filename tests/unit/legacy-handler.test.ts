// Legacy handler behavior against an in-memory client (ROADMAP.md 5.2): one SET per write, lazy tag
// invalidation, Next's stale/expired semantics, and render-start timestamps (7-6, C13).
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entryKey } from "../../src/keys";
import type { CacheEvent } from "../../src/types";
import { fakeRedis } from "../support/fake-redis";
import { clockAdvance } from "../support/wait-for";
import { appPageValue, appRouteValue, fetchValue, legacyHandler } from "../support/handlers";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(extra: Parameters<typeof legacyHandler>[0] extends infer C ? Partial<C> : never = {}) {
  const { fake, client } = fakeRedis();
  const events: CacheEvent[] = [];
  const { handler, config } = legacyHandler({ client, onEvent: (e) => events.push(e), ...extra });
  return { fake, handler, events, ns: config.namespace };
}

const page = (tags: string[] = ["t"]) => appPageValue("<p>x</p>", tags);

describe("set", () => {
  it("writes one SET with a TTL and nothing else", async () => {
    const { fake, handler, ns } = setup();
    await handler.set("/about", page(), { cacheControl: { revalidate: false } });
    expect(fake.calls.map((c) => c.cmd)).toEqual(["set"]);
    expect(fake.calls[0]!.args[0]).toBe(entryKey(ns, "b1", "/about"));
    expect(fake.expires.has(entryKey(ns, "b1", "/about"))).toBe(true);
  });

  it("uses the FETCH value's revalidate and the context tags", async () => {
    const { fake, handler } = setup();
    await handler.set("f1", fetchValue("{}", 10), { fetchCache: true, tags: ["a", "b"] });
    const opts = fake.calls[0]!.args[2] as { expiration: { value: number } };
    expect(opts.expiration.value).toBe(15);
  });

  it("does nothing when disabled", async () => {
    const { fake, handler } = setup({ disabled: true });
    await handler.set("/about", page(), {});
    expect(await handler.get("/about", { kind: "APP_PAGE" })).toBeNull();
    expect(fake.calls).toEqual([]);
  });
});

describe("get", () => {
  it("returns the stored value and lastModified; Buffers and Maps survive", async () => {
    const { handler, events } = setup();
    const before = Date.now();
    await handler.set("/about", page(), {});
    const hit = await handler.get("/about", { kind: "APP_PAGE" });
    expect(hit?.lastModified).toBeGreaterThanOrEqual(before);
    expect(hit?.value.html).toBe("<p>x</p>");
    expect(Buffer.isBuffer(hit?.value.rscData)).toBe(true);
    expect(hit?.value.segmentData.get("/_tree").toString()).toBe("tree");
    expect(events.at(-1)).toMatchObject({ type: "hit", key: "/about" });
  });

  it("needs at most two round trips: entry + request tags, then the entry's own tags", async () => {
    const { fake, handler } = setup();
    await handler.set("/about", page(["t1", "t2"]), {});
    fake.calls.length = 0;
    await handler.get("/about", { kind: "APP_PAGE" });
    expect(fake.calls.map((c) => c.cmd)).toEqual(["get", "hmGet"]);
    expect(fake.calls[1]!.args[1]).toEqual(["s:t1", "x:t1", "s:t2", "x:t2"]);
  });

  it("reads the tags of a fetch entry in the same round trip when the request names them", async () => {
    const { fake, handler } = setup();
    await handler.set("f", fetchValue(), { fetchCache: true, tags: ["a"] });
    fake.calls.length = 0;
    await handler.get("f", { kind: "FETCH", tags: ["a"], softTags: ["_N_T_/p"] });
    expect(fake.calls.map((c) => c.cmd)).toEqual(["get", "hmGet"]);
  });

  it("an entry without tags costs one command", async () => {
    const { fake, handler } = setup();
    await handler.set("/r", appRouteValue(), {});
    fake.calls.length = 0;
    await handler.get("/r", { kind: "APP_ROUTE" });
    expect(fake.calls.map((c) => c.cmd)).toEqual(["get"]);
  });

  it("is a miss (null) for an absent key, an unreadable 1.x value and while Redis is unavailable", async () => {
    const { fake, handler, ns, events } = setup();
    expect(await handler.get("/nope", {})).toBeNull();
    await fake.set(entryKey(ns, "b1", "/old"), JSON.stringify({ lastModified: 1, value: {} }));
    expect(await handler.get("/old", {})).toBeNull();
    fake.isReady = false;
    const sent = fake.calls.length;
    expect(await handler.get("/nope", {})).toBeNull();
    expect(fake.calls.length).toBe(sent);
    expect(events.map((e) => (e.type === "miss" ? e.reason : e.type))).toEqual(["absent", "format", "unavailable"]);
  });
});

describe("tag invalidation (no key is deleted)", () => {
  it("revalidateTag writes one HSET of the tag state", async () => {
    const { fake, handler, ns } = setup();
    await handler.revalidateTag(["a", "b"]);
    await handler.revalidateTag("c", { expire: 60 });
    await handler.revalidateTag([]);
    expect(fake.calls.map((c) => c.cmd)).toEqual(["hSet", "hSet"]);
    expect(fake.calls[0]!.args[0]).toBe(`${ns}:_tagstate`);
    expect(Object.keys(fake.calls[0]!.args[1] as object)).toEqual(["x:a", "x:b"]);
    expect(Object.keys(fake.calls[1]!.args[1] as object)).toEqual(["s:c", "x:c"]);
  });

  it("a page with an expired tag is served stale (lastModified -1) when the route is unknown (no build output)", async () => {
    const { fake, handler, events } = setup();
    await handler.set("/p", page(["t"]), {});
    await clockAdvance();
    await handler.revalidateTag("t");
    const got = await handler.get("/p", { kind: "APP_PAGE" });
    expect(got?.lastModified).toBe(-1);
    expect(got?.value.html).toBe("<p>x</p>");
    expect(events.at(-1)).toMatchObject({ type: "stale" });
    expect(fake.count("unlink")).toBe(0);
  });

  it("onTagExpired auto: a miss for a route that renders on demand (known from prerender-manifest.json)", async () => {
    const { fake, client } = fakeRedis();
    const { handler } = legacyHandler({ client }, fileURLToPath(new URL("../fixtures/next-build/.next/server/", import.meta.url)));
    await handler.set("/about", page(["t"]), {});
    await clockAdvance();
    await handler.revalidateTag("t");
    expect(await handler.get("/about", { kind: "APP_PAGE" })).toBeNull();
    expect(fake.count("unlink")).toBe(0);
  });

  it("onTagExpired: \"miss\" returns null for an expired page", async () => {
    const { handler } = setup({ onTagExpired: "miss" });
    await handler.set("/p", page(["t"]), {});
    await clockAdvance();
    await handler.revalidateTag("t");
    expect(await handler.get("/p", { kind: "APP_PAGE" })).toBeNull();
  });

  it("revalidateTag(tag, { expire }) keeps pages and fetch entries servable (stale) until the expiry", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { handler } = setup();
    await handler.set("/p", page(["t"]), {});
    await handler.set("f", fetchValue(), { fetchCache: true, tags: ["t"] });
    vi.advanceTimersByTime(10);
    await handler.revalidateTag("t", { expire: 60 });
    expect((await handler.get("/p", { kind: "APP_PAGE" }))?.lastModified).toBe(-1);
    expect((await handler.get("f", { kind: "FETCH", tags: ["t"] }))?.lastModified).toBe(-1);
    vi.advanceTimersByTime(61_000);
    expect(await handler.get("f", { kind: "FETCH", tags: ["t"] })).toBeNull();
    expect((await handler.get("/p", { kind: "APP_PAGE" }))?.lastModified).toBe(-1);
  });

  it("a fetch entry with an expired tag (updateTag) is a miss", async () => {
    const { handler } = setup();
    await handler.set("f", fetchValue(), { fetchCache: true, tags: ["t"] });
    await clockAdvance();
    await handler.revalidateTag("t");
    expect(await handler.get("f", { kind: "FETCH", tags: ["t"] })).toBeNull();
  });

  it("implicit (soft) tags of a fetch request are checked too", async () => {
    const { handler } = setup();
    await handler.set("f", fetchValue(), { fetchCache: true, tags: [] });
    await clockAdvance();
    await handler.revalidateTag("_N_T_/blog");
    expect(await handler.get("f", { kind: "FETCH", tags: [], softTags: ["_N_T_/blog"] })).toBeNull();
    expect(await handler.get("f", { kind: "FETCH", tags: [], softTags: ["_N_T_/other"] })).not.toBeNull();
  });

  it("an entry written after the invalidation is fresh", async () => {
    const { handler } = setup();
    await handler.revalidateTag("t");
    await clockAdvance();
    await handler.set("/p", page(["t"]), {});
    expect((await handler.get("/p", { kind: "APP_PAGE" }))?.lastModified).toBeGreaterThan(0);
  });
});

describe("render-start timestamps (7-6, C13)", () => {
  it("an invalidation that lands during a render leaves the rendered entry stale", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { handler } = setup();
    expect(await handler.get("/race", { kind: "APP_PAGE" })).toBeNull(); // render starts now
    vi.advanceTimersByTime(300);
    await handler.revalidateTag("t"); // data changes while the render still runs
    vi.advanceTimersByTime(1200);
    await handler.set("/race", page(["t"]), {}); // the render finishes with the old data
    expect((await handler.get("/race", { kind: "APP_PAGE" }))?.lastModified).toBe(-1);
  });

  it("stores the time of the triggering miss as lastModified, the earliest of concurrent misses", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { handler } = setup();
    await handler.get("/p", { kind: "APP_PAGE" });
    vi.advanceTimersByTime(100);
    await handler.get("/p", { kind: "APP_PAGE" });
    vi.advanceTimersByTime(100);
    await handler.set("/p", page([]), {});
    expect((await handler.get("/p", { kind: "APP_PAGE" }))?.lastModified).toBe(1_000_000);
  });

  it("a time-stale hit marks the render start for the regeneration that follows", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { handler } = setup();
    await handler.set("/isr", page([]), { cacheControl: { revalidate: 2 } });
    vi.advanceTimersByTime(2500);
    const stale = await handler.get("/isr", { kind: "APP_PAGE" });
    expect(stale?.lastModified).toBe(1_000_000); // Next sees it is older than revalidate and regenerates
    vi.advanceTimersByTime(400);
    await handler.set("/isr", page([]), { cacheControl: { revalidate: 2 } });
    expect((await handler.get("/isr", { kind: "APP_PAGE" }))?.lastModified).toBe(1_002_500);
  });

  it("a set without a preceding miss uses the current time", async () => {
    vi.useFakeTimers({ now: 5_000_000 });
    const { handler } = setup();
    await handler.set("/p", page([]), {});
    expect((await handler.get("/p", { kind: "APP_PAGE" }))?.lastModified).toBe(5_000_000);
  });
});

describe("instances", () => {
  it("every instance of one factory shares the state; factories are isolated", async () => {
    const { fake, client } = fakeRedis();
    const a = legacyHandler({ client, namespace: "one" });
    const b = legacyHandler({ client, namespace: "two" });
    await a.handler.set("/p", page([]), {});
    expect(await new a.Handler().get("/p", {})).not.toBeNull();
    expect(await b.handler.get("/p", {})).toBeNull();
    expect(fake.store.has("one:b1:e:/p")).toBe(true);
  });
});
