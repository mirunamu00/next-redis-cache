// Legacy handler details against an in-memory client: what a set stores (tags, revalidate, TTL), miss
// reasons, render-start bookkeeping limits, build id detection from Next's context, error paths of the
// build-output fallback and re-seeding (ROADMAP.md 5.2, 5.4, 7-6, 7-11).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decodeEnvelope, encodeEnvelope } from "../../src/envelope";
import { entryKey } from "../../src/keys";
import type { CacheEvent, RedisCacheConfig } from "../../src/types";
import { BUILD_TIME, buildCopy, type BuildCopy } from "../support/build-fixture";
import { fakeRedis, type FakeRedis } from "../support/fake-redis";
import { appPageValue, appRouteValue, fetchValue, legacyHandler } from "../support/handlers";
import { waitFor } from "../support/wait-for";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function setup(extra: Partial<RedisCacheConfig> = {}, serverDistDir?: string) {
  const { fake, client } = fakeRedis();
  const events: CacheEvent[] = [];
  const { handler, config, Handler } = legacyHandler({ client, onEvent: (e) => events.push(e), ...extra }, serverDistDir);
  const key = (cacheKey: string, buildId = "b1") => entryKey(config.namespace, buildId, cacheKey);
  return { fake, handler, events, key, Handler, tagKey: `${config.namespace}:_tagstate` };
}

const T0 = 1_000_000;
const PAGE = { kind: "APP_PAGE" } as const;
const reasons = (events: CacheEvent[]) => events.flatMap((e) => (e.type === "miss" ? [e.reason] : []));
const setArgs = (fake: FakeRedis) => fake.calls.filter((c) => c.cmd === "set").at(-1)!.args as [string, Buffer, { expiration: { value: number }; condition?: string }];
async function storedMeta(fake: FakeRedis) {
  return (await decodeEnvelope<{ lastModified: number; tags: string[]; revalidate?: number | false }>(setArgs(fake)[1])).meta;
}

describe("what set stores", () => {
  it("page tags come from the x-next-cache-tags header (string or array), never from the context", async () => {
    const { fake, handler } = setup();
    await handler.set("/a", { ...appPageValue("x"), headers: { "x-next-cache-tags": "a,,b" } }, { tags: ["ctx"] });
    expect((await storedMeta(fake)).tags).toEqual(["a", "b"]);
    await handler.set("/b", { ...appPageValue("x"), headers: { "x-next-cache-tags": ["c", "", 5, "d"] } }, {});
    expect((await storedMeta(fake)).tags).toEqual(["c", "d"]);
    await handler.set("/c", { ...appPageValue("x"), headers: { "x-next-cache-tags": "" } }, {});
    expect((await storedMeta(fake)).tags).toEqual([]);
    await handler.set("/d", { kind: "APP_ROUTE", body: Buffer.from("x"), status: 200 }, {});
    expect((await storedMeta(fake)).tags).toEqual([]);
    await handler.set("/e", null, {});
    expect((await storedMeta(fake)).tags).toEqual([]);
    expect(await handler.get("/e", {})).toEqual({ lastModified: expect.any(Number), value: null });
    await handler.set("/f", { ...appPageValue("x"), headers: { "x-next-cache-tags": 5 } }, {});
    expect((await storedMeta(fake)).tags).toEqual([]);
    await handler.set("/g", null, { fetchCache: true, tags: ["t"] });
    expect(await storedMeta(fake)).toMatchObject({ tags: ["t"] });
  });

  it("fetch entries (value kind FETCH or ctx.fetchCache) take the unique context tags and the value's revalidate", async () => {
    const { fake, handler } = setup();
    await handler.set("f1", fetchValue("{}", 10), { tags: ["a", "a", ""], revalidate: 99 });
    expect(await storedMeta(fake)).toMatchObject({ tags: ["a"], revalidate: 10 });
    expect(setArgs(fake)[2].expiration.value).toBe(15);
    await handler.set("f2", { kind: "OTHER", revalidate: 20, headers: { "x-next-cache-tags": "h" } }, { fetchCache: true, tags: ["b"] });
    expect(await storedMeta(fake)).toMatchObject({ tags: ["b"], revalidate: 20 });
    await handler.set("f3", fetchValue("{}", 10), {});
    expect((await storedMeta(fake)).tags).toEqual([]);
  });

  it("page revalidate comes from cacheControl, then ctx.revalidate; the TTL follows it", async () => {
    const { fake, handler } = setup();
    await handler.set("/a", appPageValue(), { cacheControl: { revalidate: 10 }, revalidate: 100 });
    expect([(await storedMeta(fake)).revalidate, setArgs(fake)[2].expiration.value]).toEqual([10, 15]);
    await handler.set("/b", appPageValue(), { revalidate: 100 });
    expect([(await storedMeta(fake)).revalidate, setArgs(fake)[2].expiration.value]).toEqual([100, 150]);
    await handler.set("/c", appPageValue(), { cacheControl: { revalidate: false }, revalidate: 100 });
    expect([(await storedMeta(fake)).revalidate, setArgs(fake)[2].expiration.value]).toEqual([false, 30 * 24 * 3600]);
    await handler.set("/d", appPageValue(), {});
    expect(setArgs(fake)[2]).toEqual({ expiration: { type: "EX", value: 30 * 24 * 3600 } });
  });

  it("emits a set event with the stored size", async () => {
    const { fake, handler, events } = setup();
    await handler.set("/a", appRouteValue("body"), {});
    expect(events).toEqual([{ type: "set", handler: "legacy", key: "/a", bytes: setArgs(fake)[1].byteLength }]);
  });

  it("a set while Redis is not ready sends nothing and warns once; without a client it is silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { fake, handler, events } = setup();
    fake.isReady = false;
    await handler.set("/a", appPageValue(), {});
    await handler.set("/b", appPageValue(), {});
    expect(fake.calls).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/legacy set failed \(\/a\): Redis unavailable \(not-ready\)/);
    expect(events).toEqual([]);
    warn.mockClear();
    const none = setup({ client: null });
    await none.handler.set("/a", appPageValue(), {});
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("a failed SET is an error event and a warning; the next success logs the recovery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { fake, handler, events } = setup();
    fake.failOn.set("set", new Error("OOM"));
    await handler.set("/a", appPageValue(), {});
    expect(events.find((e) => e.type === "error")).toMatchObject({ handler: "legacy", op: "set", key: "/a" });
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/legacy set failed \(\/a\): OOM/);
    fake.failOn.clear();
    await handler.set("/a", appPageValue(), {});
    expect(String(info.mock.calls[0]?.[0])).toMatch(/legacy recovered/);
  });
});

describe("get details", () => {
  it("an absent entry is a miss event of the legacy handler", async () => {
    const { handler, events } = setup();
    expect(await handler.get("/nope", PAGE)).toBeNull();
    expect(events).toEqual([{ type: "miss", handler: "legacy", key: "/nope", reason: "absent" }]);
  });

  it("an unreadable entry is logged at debug level", async () => {
    const lines: string[] = [];
    const { fake, handler, key } = setup({ logger: { debug: (m: unknown) => void lines.push(String(m)) } });
    await fake.set(key("/old"), "1.x json");
    expect(await handler.get("/old", PAGE)).toBeNull();
    expect(lines).toEqual(["[next-redis-cache] legacy get /old: unreadable entry (not a next-redis-cache 2.x entry)"]);
  });

  it("an entry stored without a tag list has no tags to read", async () => {
    const { fake, handler, key } = setup();
    await fake.set(key("/p"), await encodeEnvelope({ lastModified: 5 }, { kind: "APP_ROUTE", body: Buffer.from("x"), status: 200, headers: {} }));
    fake.calls.length = 0;
    expect((await handler.get("/p", { kind: "APP_ROUTE" }))?.lastModified).toBe(5);
    expect(fake.calls.map((c) => c.cmd)).toEqual(["get"]);
  });

  it("a successful get after a failure logs the recovery; a failed tag read names the operation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { fake, handler } = setup();
    await handler.set("/p", appPageValue("x", ["t"]), {});
    fake.failOn.set("hmGet", new Error("LOADING"));
    expect(await handler.get("/p", PAGE)).not.toBeNull();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/legacy get failed \(\/p\): LOADING/);
    fake.failOn.clear();
    await handler.get("/nope", PAGE);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/legacy recovered/);
  });

  it("reads time out after timeouts.readMs, writes use timeouts.writeMs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, handler } = setup({ timeouts: { readMs: 50, writeMs: 10_000 } });
    await handler.set("/p", appPageValue("x", ["t"]), {});
    fake.hanging = true;
    const t0 = Date.now();
    expect(await handler.get("/p", PAGE)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
    const slow = setup({ timeouts: { readMs: 10_000, writeMs: 50 } });
    slow.fake.hanging = true;
    const t1 = Date.now();
    await slow.handler.set("/p", appPageValue(), {});
    await slow.handler.revalidateTag("t");
    expect(Date.now() - t1).toBeLessThan(2000);
  });

  it("the entry's own tags are read with timeouts.readMs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, handler } = setup({ timeouts: { readMs: 50, writeMs: 10_000 } });
    await handler.set("/p", appPageValue("x", ["t"]), {});
    const hmGet = fake.hmGet.bind(fake);
    fake.hmGet = () => new Promise(() => {}) as never; // only the tag read hangs
    const t0 = Date.now();
    expect(await handler.get("/p", PAGE)).not.toBeNull(); // served as it is
    expect(Date.now() - t0).toBeLessThan(2000);
    fake.hmGet = hmGet;
  });

  it("a disabled handler answers with a disabled miss and sends nothing", async () => {
    const { fake, handler, events } = setup({ disabled: true });
    expect(await handler.get("/a", PAGE)).toBeNull();
    expect(events).toEqual([{ type: "miss", handler: "legacy", key: "/a", reason: "disabled" }]);
    expect(fake.calls).toEqual([]);
  });

  it("a failing GET is an error miss, reported once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, handler, events } = setup();
    fake.failOn.set("get", new Error("MISCONF"));
    expect(await handler.get("/a", PAGE)).toBeNull();
    expect(reasons(events)).toEqual(["error"]);
    expect(events.find((e) => e.type === "error")).toMatchObject({ handler: "legacy", op: "get", key: "/a" });
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/legacy get failed \(\/a\): MISCONF/);
  });

  it("the request's tags and soft tags are read with the entry as one unique, non-empty list", async () => {
    const { fake, handler, tagKey } = setup();
    await handler.set("f", fetchValue(), { fetchCache: true, tags: ["a"] });
    fake.calls.length = 0;
    await handler.get("f", { kind: "FETCH", tags: ["a", "", "b"], softTags: ["b", "s"] });
    expect(fake.calls[1]).toEqual({ cmd: "hmGet", args: [tagKey, ["s:a", "x:a", "s:b", "x:b", "s:s", "x:s"]] });
    expect(fake.calls).toHaveLength(2);
  });

  it("a hit emits a hit event; a stale tag emits a stale event with reason tag", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler, events } = setup();
    await handler.set("/p", appPageValue("x", ["t"]), {});
    expect((await handler.get("/p", PAGE))?.lastModified).toBe(T0);
    expect(events.at(-1)).toEqual({ type: "hit", handler: "legacy", key: "/p" });
    vi.advanceTimersByTime(1);
    await handler.revalidateTag("t", { expire: 60 });
    expect((await handler.get("/p", PAGE))?.lastModified).toBe(-1);
    expect(events.at(-1)).toEqual({ type: "stale", handler: "legacy", key: "/p", reason: "tag" });
  });

  it("an invalidation in the same millisecond as the entry keeps it fresh (Next compares strictly)", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler } = setup();
    await handler.set("/p", appPageValue("x", ["t"]), {});
    await handler.revalidateTag("t");
    expect((await handler.get("/p", PAGE))?.lastModified).toBe(T0);
  });

  it("a fetch value is recognized by its kind even without ctx.kind: an expired tag is a miss, not stale", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler, events } = setup({ onTagExpired: "stale" });
    await handler.set("f", fetchValue(), { fetchCache: true, tags: ["t"] });
    vi.advanceTimersByTime(1);
    await handler.revalidateTag("t");
    expect(await handler.get("f", { tags: ["t"] })).toBeNull();
    expect(events.at(-1)).toEqual({ type: "miss", handler: "legacy", key: "f", reason: "tag" });
    expect(await handler.get("f", { kind: "FETCH", tags: ["t"] })).toBeNull();
  });

  it("onTagExpired stale serves an expired page with lastModified -1", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler } = setup({ onTagExpired: "stale" });
    await handler.set("/p", appPageValue("x", ["t"]), {});
    vi.advanceTimersByTime(1);
    await handler.revalidateTag("t");
    expect((await handler.get("/p", PAGE))?.lastModified).toBe(-1);
  });

  it("an expired-tag miss is a render start: the regenerated entry keeps the time of that miss", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler } = setup({ onTagExpired: "miss" });
    await handler.set("/p", appPageValue("x", ["t"]), {});
    vi.advanceTimersByTime(10);
    await handler.revalidateTag("t");
    vi.advanceTimersByTime(10);
    expect(await handler.get("/p", PAGE)).toBeNull();
    vi.advanceTimersByTime(500);
    await handler.set("/p", appPageValue("x", ["t"]), {});
    expect((await handler.get("/p", PAGE))?.lastModified).toBe(T0 + 20);
  });

  it("a stale answer is a render start too", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler } = setup();
    await handler.set("/p", appPageValue("x", ["t"]), {});
    vi.advanceTimersByTime(10);
    await handler.revalidateTag("t", { expire: 60 });
    vi.advanceTimersByTime(10);
    expect((await handler.get("/p", PAGE))?.lastModified).toBe(-1);
    vi.advanceTimersByTime(500);
    await handler.set("/p", appPageValue("x", ["t"]), {});
    expect((await handler.get("/p", PAGE))?.lastModified).toBe(T0 + 20); // the time of the stale answer
  });

  it("an entry exactly at lastModified + revalidate is not yet time-stale (no render start)", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler } = setup();
    await handler.set("/isr", appPageValue(), { cacheControl: { revalidate: 2 } });
    vi.advanceTimersByTime(2000);
    await handler.get("/isr", PAGE);
    vi.advanceTimersByTime(400);
    await handler.set("/isr", appPageValue(), { cacheControl: { revalidate: 2 } });
    expect((await handler.get("/isr", PAGE))?.lastModified).toBe(T0 + 2400);
  });

  it("an entry without a numeric revalidate never marks a render start", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler } = setup();
    await handler.set("/s", appPageValue(), { cacheControl: { revalidate: false } });
    vi.advanceTimersByTime(10_000_000);
    await handler.get("/s", PAGE);
    vi.advanceTimersByTime(400);
    await handler.set("/s", appPageValue(), {});
    expect((await handler.get("/s", PAGE))?.lastModified).toBe(T0 + 10_000_400);
  });
});

describe("render-start bookkeeping", () => {
  it("a second miss exactly five minutes after the first keeps the first one", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler } = setup();
    await handler.get("/a", PAGE);
    vi.advanceTimersByTime(5 * 60_000);
    await handler.get("/a", PAGE);
    await handler.set("/a", appPageValue(), {});
    expect((await handler.get("/a", PAGE))?.lastModified).toBe(T0);
  });

  it("a render start older than five minutes is ignored, and a new miss then replaces it", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler } = setup();
    await handler.get("/a", PAGE);
    await handler.get("/b", PAGE);
    vi.advanceTimersByTime(5 * 60_000);
    await handler.set("/a", appPageValue(), {}); // exactly five minutes: still the render start
    expect((await handler.get("/a", PAGE))?.lastModified).toBe(T0);
    vi.advanceTimersByTime(1);
    await handler.get("/b", PAGE); // the old start expired: this miss is the new one
    vi.advanceTimersByTime(100);
    await handler.set("/b", appPageValue(), {});
    expect((await handler.get("/b", PAGE))?.lastModified).toBe(T0 + 5 * 60_000 + 1);
  });

  it("a render start is used once", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler } = setup();
    await handler.get("/a", PAGE);
    vi.advanceTimersByTime(100);
    await handler.set("/a", appPageValue(), {});
    vi.advanceTimersByTime(100);
    await handler.set("/a", appPageValue(), {});
    expect((await handler.get("/a", PAGE))?.lastModified).toBe(T0 + 200);
  });

  it("an expired render start is ignored by set", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler } = setup();
    await handler.get("/a", PAGE);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await handler.set("/a", appPageValue(), {});
    expect((await handler.get("/a", PAGE))?.lastModified).toBe(T0 + 5 * 60_000 + 1);
  });


  it("keeps at most 10,000 render starts and drops the oldest first", async () => {
    vi.useFakeTimers({ now: T0 });
    const { handler } = setup();
    await handler.get("/first", PAGE);
    vi.advanceTimersByTime(1);
    await handler.get("/second", PAGE);
    vi.advanceTimersByTime(1);
    for (let i = 0; i < 9_998; i++) await handler.get(`/k${i}`, PAGE);
    await handler.get("/second", PAGE); // already marked: adds no key
    vi.advanceTimersByTime(10);
    await handler.get("/overflow", PAGE); // the 10,001st key drops /first
    await handler.set("/first", appPageValue(), {});
    await handler.set("/second", appPageValue(), {});
    expect((await handler.get("/first", PAGE))?.lastModified).toBe(T0 + 12);
    expect((await handler.get("/second", PAGE))?.lastModified).toBe(T0 + 1);
  });
});

describe("revalidateTag details", () => {
  it("one HSET for the unique, non-empty tags of a string or a list; nothing for none or while disabled", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fake, handler, tagKey } = setup();
    await handler.revalidateTag(["a", "", "a", "b"]);
    await handler.revalidateTag("c");
    await handler.revalidateTag("");
    await handler.revalidateTag(undefined as unknown as string[]);
    expect(fake.calls).toEqual([
      { cmd: "hSet", args: [tagKey, { "x:a": String(T0), "x:b": String(T0) }] },
      { cmd: "hSet", args: [tagKey, { "x:c": String(T0) }] },
    ]);
    const off = setup({ disabled: true });
    await off.handler.revalidateTag("a");
    expect(off.fake.calls).toEqual([]);
  });

  it("a failed HSET is an error event with the tag list; the next success logs the recovery", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { fake, handler, events } = setup();
    fake.failOn.set("hSet", new Error("READONLY"));
    await handler.revalidateTag(["a", "b"]);
    expect(events.find((e) => e.type === "error")).toMatchObject({ handler: "legacy", op: "revalidateTag", key: "a,b" });
    fake.failOn.clear();
    await handler.revalidateTag("a");
    expect(String(info.mock.calls[0]?.[0])).toMatch(/legacy recovered/);
  });

  it("resetRequestCache is a no-op", () => {
    const { fake, handler } = setup();
    expect(handler.resetRequestCache()).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });
});

describe("build id from Next's context", () => {
  const dirs: string[] = [];
  const dist = (id: string, variant: "server" | "server/" | "server\\" = "server") => {
    const root = mkdtempSync(path.join(tmpdir(), "nrc-bid-"));
    dirs.push(root);
    const distDir = path.join(root, ".next");
    mkdirSync(path.join(distDir, "server"), { recursive: true });
    writeFileSync(path.join(distDir, "BUILD_ID"), id);
    return `${distDir}${path.sep === "\\" ? "\\" : "/"}${variant}`;
  };

  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("reads BUILD_ID next to serverDistDir (the first context that has one wins)", async () => {
    vi.stubEnv("BUILD_ID", "");
    const { fake, client } = fakeRedis();
    const { Handler, config } = legacyHandler({ client, buildId: undefined });
    new Handler({}); // no serverDistDir yet
    const h = new Handler({ serverDistDir: dist("first") });
    new Handler({ serverDistDir: dist("second") });
    await h.set("/p", appPageValue(), {});
    expect(fake.calls[0]!.args[0]).toBe(entryKey(config.namespace, "first", "/p"));
  });

  it("strips only the last server segment (a parent directory may be called server too)", async () => {
    vi.stubEnv("BUILD_ID", "");
    const root = mkdtempSync(path.join(tmpdir(), "nrc-bid-"));
    dirs.push(root);
    const distDir = path.join(root, "server", ".next");
    mkdirSync(path.join(distDir, "server"), { recursive: true });
    writeFileSync(path.join(distDir, "BUILD_ID"), "nested");
    const { fake, client } = fakeRedis();
    const { Handler, config } = legacyHandler({ client, buildId: undefined });
    await new Handler({ serverDistDir: path.join(distDir, "server") }).set("/p", appPageValue(), {});
    expect(fake.calls[0]!.args[0]).toBe(entryKey(config.namespace, "nested", "/p"));
  });

  it.each(["server/", "server\\"] as const)("strips a trailing %s from serverDistDir", async (variant) => {
    vi.stubEnv("BUILD_ID", "");
    const { fake, client } = fakeRedis();
    const { Handler, config } = legacyHandler({ client, buildId: undefined });
    const h = new Handler({ serverDistDir: dist(`id-${variant.length}`, variant) });
    await h.set("/p", appPageValue(), {});
    expect(fake.calls[0]!.args[0]).toBe(entryKey(config.namespace, `id-${variant.length}`, "/p"));
  });
});

describe("build-output fallback error paths", () => {
  let copy: BuildCopy;
  beforeAll(() => {
    copy = buildCopy();
  });
  afterAll(() => copy?.cleanup());

  const fallback = (extra: Partial<RedisCacheConfig> = {}) => setup({ fallback: {}, ...extra }, copy.serverDistDir);

  it("a failing GET falls back with an unknown tag state and sends nothing more", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, handler, events } = fallback();
    fake.failOn.set("get", new Error("MISCONF"));
    const got = await handler.get("/about", PAGE);
    expect(got?.lastModified).toBe(BUILD_TIME.getTime());
    expect(events).toContainEqual({ type: "fallback", handler: "legacy", key: "/about", state: "unknown" });
    expect(fake.calls.map((c) => c.cmd)).toEqual(["get"]);
  });

  it("an unreadable Redis entry falls back to the build output after checking the tags", async () => {
    const { fake, handler, events, key } = fallback();
    await fake.set(key("/about"), "1.x json");
    fake.calls.length = 0;
    expect((await handler.get("/about", PAGE))?.lastModified).toBe(BUILD_TIME.getTime());
    expect(events).toContainEqual({ type: "fallback", handler: "legacy", key: "/about", state: "fresh" });
    expect(fake.calls.map((c) => c.cmd).slice(0, 2)).toEqual(["get", "hmGet"]);
  });

  it("the build output is looked for again once Next's context names serverDistDir", async () => {
    const { client } = fakeRedis();
    const events: CacheEvent[] = [];
    const { Handler } = legacyHandler({ client, fallback: {}, onEvent: (e) => events.push(e) });
    const early = new Handler(); // created before Next passed its context
    expect(await early.get("/about", PAGE)).toBeNull();
    new Handler({ serverDistDir: copy.serverDistDir });
    expect((await early.get("/about", PAGE))?.lastModified).toBe(BUILD_TIME.getTime());
    expect(events).toContainEqual({ type: "fallback", handler: "legacy", key: "/about", state: "fresh" });
  });

  it("a re-seed is a reseed event of the legacy handler; a failed one is reported as reseed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = fallback();
    await ok.handler.get("/about", PAGE);
    await waitFor(() => ok.events.some((e) => e.type === "reseed"), { message: "reseed" });
    expect(ok.events.find((e) => e.type === "reseed")).toEqual({ type: "reseed", handler: "legacy", key: "/about" });
    const failing = fallback();
    failing.fake.failOn.set("set", new Error("OOM"));
    await failing.handler.get("/about", PAGE);
    await waitFor(() => warn.mock.calls.length > 0, { message: "reseed failure" });
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/legacy reseed failed \(\/about\): OOM/);
  });

  it("a failing tag read falls back with an unknown state, reported, and does not re-seed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, handler, events } = fallback();
    fake.failOn.set("hmGet", new Error("LOADING"));
    expect((await handler.get("/about", PAGE))?.lastModified).toBe(BUILD_TIME.getTime());
    expect(events).toContainEqual({ type: "fallback", handler: "legacy", key: "/about", state: "unknown" });
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/legacy get failed \(\/about\): LOADING/);
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.count("set")).toBe(0);
  });

  it("the request's soft tags are checked against the build output too", async () => {
    const { handler, events } = fallback();
    await handler.revalidateTag("_N_T_/extra");
    expect(await handler.get("/about", { kind: "APP_PAGE", softTags: ["_N_T_/extra"] })).toBeNull();
    expect(events.at(-1)).toEqual({ type: "miss", handler: "legacy", key: "/about", reason: "tag" });
  });

  it("an absent key with a kind outside the build output is a plain miss", async () => {
    const { fake, handler, events } = fallback();
    expect(await handler.get("/about", { kind: "PAGES" })).toBeNull();
    expect(await handler.get("/about", {})).toBeNull();
    expect(reasons(events)).toEqual(["absent", "absent"]);
    expect(fake.calls.map((c) => c.cmd)).toEqual(["get", "get"]);
  });

  it("does not re-seed a key that is not a prerendered route of this build", async () => {
    const other = buildCopy({ manifest: (m) => void delete m.routes["/about"] });
    try {
      const { fake, handler, events } = setup({ fallback: {} }, other.serverDistDir);
      expect((await handler.get("/about", PAGE))?.lastModified).toBe(BUILD_TIME.getTime());
      await new Promise((r) => setTimeout(r, 50));
      expect(fake.count("set")).toBe(0);
      expect(events.some((e) => e.type === "reseed")).toBe(false);
    } finally {
      other.cleanup();
    }
  });

  it("a re-seed that finds a newer entry (SET NX refused) emits no reseed event and keeps the entry", async () => {
    const { fake, handler, events, key } = fallback();
    const get = fake.get.bind(fake);
    fake.get = (k: string) => {
      // another instance stores the page between this GET and the re-seed
      const reply = get(k);
      void fake.set(k, Buffer.from("newer"));
      return reply;
    };
    expect((await handler.get("/about", PAGE))?.lastModified).toBe(BUILD_TIME.getTime());
    await waitFor(() => fake.calls.some((c) => c.cmd === "set" && (c.args[2] as { condition?: string })?.condition === "NX"), { message: "reseed SET NX" });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.some((e) => e.type === "reseed" || e.type === "set")).toBe(false);
    expect((fake.store.get(key("/about"))!.data as Buffer).toString()).toBe("newer");
  });

  it("re-seeds one key once at a time, and again after the first one finished", async () => {
    const { fake, handler, events, key } = fallback();
    await Promise.all([handler.get("/about", PAGE), handler.get("/about", PAGE)]);
    await waitFor(() => events.some((e) => e.type === "reseed"), { message: "first reseed" });
    await fake.unlink(key("/about"));
    await handler.get("/about", PAGE);
    await waitFor(() => events.filter((e) => e.type === "reseed").length === 2, { message: "second reseed" });
    expect(events.filter((e) => e.type === "set")).toHaveLength(2);
  });
});
