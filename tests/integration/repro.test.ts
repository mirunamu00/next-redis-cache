// Regressions against real Redis (ROADMAP.md 7-1, 7-5, 7-6, 7-9, 7-11, 7-12, A8), once per Redis version
// under test. Each asserts the correct behavior; the 7-x tests were expected failures on 1.0.6. `itRepro`
// would mark what is still expected to fail (tests/support/repro.ts); none is left.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redisVersionsUnderTest, startRedisContainer, type RedisServer } from "../support/redis-container";
import { connectTestClient, type TestRedisClient, type TrackedClient } from "../support/redis";
import { uniqueNamespace } from "../support/namespace";
import { clockAdvance, waitFor } from "../support/wait-for";
import { appPageValue, appRouteValue, fetchValue, legacyHandler, readEntry, testConfig, useCacheEntry, useCacheHandler } from "../support/handlers";
import { cleanupOldBuildKeys } from "../../src/legacy-cleanup";
import { LegacyCore } from "../../src/legacy-handler";
import { resolveConfig } from "../../src/config";
import { decodeEnvelope, encodeEnvelope } from "../../src/envelope";
import { entryKey } from "../../src/keys";

const YEAR = 365 * 24 * 3600;
const tick = () => clockAdvance(2);

describe.each(redisVersionsUnderTest())("Redis %s", (version) => {
  let server: RedisServer;
  let tracked: TrackedClient;
  let client: TestRedisClient;

  beforeAll(async () => {
    server = await startRedisContainer(version);
    tracked = await connectTestClient(server.url);
    client = tracked.client;
  });

  afterAll(async () => {
    tracked?.close();
    await server?.stop();
  });

  const nsKeys = async (ns: string) => {
    const keys: string[] = [];
    for await (const batch of client.scanIterator({ MATCH: `${ns}:*`, COUNT: 500 })) keys.push(...batch.map(String));
    return keys.sort();
  };

  describe("7-1 updateTags durations", () => {
    it("[7-1] updateTags without durations expires tagged entries (immediate expiry works)", async () => {
      const { handler: uc } = useCacheHandler({ client: client as never });
      await uc.set("k", Promise.resolve(useCacheEntry({ tags: ["t"], timestamp: Date.now() - 1000 })));
      await uc.updateTags(["t"]);
      expect(await uc.get("k", [])).toBeUndefined();
    });

    it("[7-1] an entry written after updateTags(tags, { expire: 1y }) is readable", async () => {
      const { handler: uc } = useCacheHandler({ client: client as never });
      await uc.updateTags(["t"], { expire: YEAR });
      await tick();
      await uc.set("k", Promise.resolve(useCacheEntry({ value: "fresh", tags: ["t"] })));
      expect(await readEntry(await uc.get("k", []))).toBe("fresh");
    });

    it("[7-1] an entry written before updateTags(tags, { expire: 1y }) is served stale once, not dropped", async () => {
      const { handler: uc } = useCacheHandler({ client: client as never });
      await uc.set("k", Promise.resolve(useCacheEntry({ value: "old", tags: ["t"], timestamp: Date.now() - 1000 })));
      await uc.updateTags(["t"], { expire: YEAR });
      const entry = await uc.get("k", []);
      expect(entry?.revalidate).toBe(-1);
      expect(await readEntry(entry)).toBe("old");
    });

    it("[7-1] a legacy entry written after a use-cache updateTags(tags, { expire }) is fresh (shared tag state)", async () => {
      const ns = uniqueNamespace();
      const { handler: uc } = useCacheHandler({ client: client as never, namespace: ns });
      const { handler } = legacyHandler({ client: client as never, namespace: ns });
      await uc.updateTags(["t"], { expire: YEAR });
      await tick();
      await handler.set("/page", appPageValue("<p>fresh</p>", ["t"]), { cacheControl: { revalidate: false } });
      expect((await handler.get("/page", { kind: "APP_PAGE" }))?.lastModified).toBeGreaterThan(0);
    });

    it("[7-1] an invalidation through the legacy handler reaches use-cache entries and vice versa", async () => {
      const ns = uniqueNamespace();
      const { handler: uc } = useCacheHandler({ client: client as never, namespace: ns });
      const { handler } = legacyHandler({ client: client as never, namespace: ns });
      await uc.set("k", Promise.resolve(useCacheEntry({ tags: ["a"], timestamp: Date.now() - 1000 })));
      await handler.set("/p", appPageValue("<p>x</p>", ["b"]), {});
      await tick();
      await handler.revalidateTag("a");
      await uc.updateTags(["b"]);
      expect(await uc.get("k", [])).toBeUndefined();
      expect((await handler.get("/p", { kind: "APP_PAGE" }))?.lastModified).toBe(-1);
    });
  });

  describe("7-5 nothing outlives the entries", () => {
    it("[7-5] expired entries leave no per-entry metadata behind (only the shared tag state stays)", async () => {
      const ns = uniqueNamespace();
      const { handler } = legacyHandler({ client: client as never, namespace: ns, ttl: { estimateExpire: () => 1 } });
      for (let i = 0; i < 50; i++) await handler.set(`/f${i}`, fetchValue("{}", 1), { fetchCache: true, tags: ["t"] });
      await handler.revalidateTag("t");
      expect((await nsKeys(ns)).length).toBe(51);
      await waitFor(async () => (await nsKeys(ns)).length === 1, { timeout: 5000, message: "entries expired" });
      expect(await nsKeys(ns)).toEqual([`${ns}:_tagstate`]);
    });

    it("[7-5] a corrupted tag state field does not stop invalidation of other tags", async () => {
      const ns = uniqueNamespace();
      const { handler } = legacyHandler({ client: client as never, namespace: ns });
      await client.hSet(`${ns}:_tagstate`, { "x:broken": "{not a number", "s:t": "garbage" });
      await handler.set("/page", appPageValue("<p>x</p>", ["broken", "t"]), {});
      await tick();
      await handler.revalidateTag("t");
      expect((await handler.get("/page", { kind: "APP_PAGE" }))?.lastModified).toBe(-1);
    });

    it("[7-5] every entry key has a TTL", async () => {
      const ns = uniqueNamespace();
      const { handler } = legacyHandler({ client: client as never, namespace: ns });
      const { handler: uc } = useCacheHandler({ client: client as never, namespace: ns });
      await handler.set("/about", appPageValue(), { cacheControl: { revalidate: false } });
      await handler.set("/r", appRouteValue(), { cacheControl: { revalidate: 60 } });
      await uc.set("k", Promise.resolve(useCacheEntry()));
      await uc.updateTags(["t"]);
      for (const key of await nsKeys(ns)) {
        const pttl = await client.pTTL(key);
        if (key.endsWith(":_tagstate")) expect(pttl).toBe(-1);
        else expect(pttl, key).toBeGreaterThan(0);
      }
    });
  });

  describe("7-6 legacy revalidateTag semantics", () => {
    it("[7-6] revalidateTag(tag, { expire }) keeps the entry servable while it is regenerated (SWR)", async () => {
      const { handler } = legacyHandler({ client: client as never });
      await handler.set("/page", appPageValue("<p>old</p>", ["t"]), { cacheControl: { revalidate: false } });
      await tick();
      await handler.revalidateTag("t", { expire: 3600 });
      const got = await handler.get("/page", { kind: "APP_PAGE" });
      expect(got?.lastModified).toBe(-1);
      expect(got?.value.html).toBe("<p>old</p>");
    });

    it("[7-6] an entry rendered across an explicit-tag invalidation is not served as fresh afterwards", async () => {
      const { handler } = legacyHandler({ client: client as never });
      expect(await handler.get("/page", { kind: "APP_PAGE" })).toBeNull(); // miss: Next starts rendering
      await tick();
      await handler.revalidateTag("t"); // the data changes during the render
      await tick();
      await handler.set("/page", appPageValue("<p>old</p>", ["t"]), { cacheControl: { revalidate: false } });
      expect((await handler.get("/page", { kind: "APP_PAGE" }))?.lastModified).toBe(-1);
    });

    it("[7-6] revalidateTag deletes nothing: a dynamicParams=false page keeps an answer", async () => {
      const ns = uniqueNamespace();
      const { handler } = legacyHandler({ client: client as never, namespace: ns });
      await handler.set("/pinned/4", appPageValue("<p>v1</p>", ["_N_T_/pinned/4"]), {});
      await tick();
      await handler.revalidateTag("_N_T_/pinned/4");
      expect(await client.exists(entryKey(ns, "b1", "/pinned/4"))).toBe(1);
      expect((await handler.get("/pinned/4", { kind: "APP_PAGE" }))?.value.html).toBe("<p>v1</p>");
    });
  });

  describe("A8 two instances on one Redis", () => {
    it("[A8] an invalidation on one instance is visible on the other's next read", async () => {
      const ns = uniqueNamespace();
      const second = await connectTestClient(server.url);
      try {
        const a = useCacheHandler({ client: client as never, namespace: ns }).handler;
        const b = useCacheHandler({ client: second.client as never, namespace: ns }).handler;
        await a.set("k", Promise.resolve(useCacheEntry({ value: "shared", tags: ["t"], timestamp: Date.now() - 1000 })));
        expect(await readEntry(await b.get("k", []))).toBe("shared");
        await a.updateTags(["t"]);
        expect(await b.get("k", [])).toBeUndefined();
      } finally {
        second.close();
      }
    });
  });

  describe("7-9 cleanupOldBuildKeys (deprecated, 1.x layout)", () => {
    it("[7-9] deletes in batches of at most 500 keys", async () => {
      const ns = uniqueNamespace();
      const multi = client.multi();
      for (let i = 0; i < 10_000; i++) multi.set(`${ns}:old:k${i}`, "x", { expiration: { type: "EX", value: 600 } });
      await multi.exec();
      const calls = async () => {
        const info = await client.info("commandstats");
        const n = (cmd: string) => Number(new RegExp(`cmdstat_${cmd}:calls=(\\d+)`).exec(info)?.[1] ?? 0);
        return n("del") + n("unlink");
      };
      const before = await calls();
      const { deleted } = await cleanupOldBuildKeys({ redisUrl: server.url, patterns: [{ scan: `${ns}:*`, keepPrefix: `${ns}:new:` }] });
      expect(deleted).toBe(10_000);
      expect((await calls()) - before).toBeGreaterThanOrEqual(20);
    });

    it("[7-9] overlapping patterns delete and count every key once", async () => {
      const ns = uniqueNamespace();
      for (let i = 0; i < 100; i++) await client.set(`${ns}:old:k${i}`, "x", { expiration: { type: "EX", value: 600 } });
      const { deleted } = await cleanupOldBuildKeys({ redisUrl: server.url, patterns: [{ scan: `${ns}:*` }, { scan: `${ns}:old:*` }] });
      expect(deleted).toBe(100);
    });

    // Keeping a build that is still being read is the job of cleanupOldBuilds (tests/integration/maintenance.test.ts);
    // the deprecated pattern cleanup deletes whatever the patterns match.
  });

  describe("7-11 TTL", () => {
    it("[7-11] APP_ROUTE revalidate=5 (cacheControl) has PTTL of about 7.5s", async () => {
      const ns = uniqueNamespace();
      const { handler } = legacyHandler({ client: client as never, namespace: ns });
      await handler.set("/api/timed", appRouteValue(), { cacheControl: { revalidate: 5, expire: undefined } });
      const pttl = await client.pTTL(entryKey(ns, "b1", "/api/timed"));
      expect(pttl).toBeGreaterThan(6_000);
      expect(pttl).toBeLessThanOrEqual(7_500);
    });

    it("[7-11] a use-cache entry lives until its expire (remaining lifetime + 1 s)", async () => {
      const ns = uniqueNamespace();
      const { handler } = useCacheHandler({ client: client as never, namespace: ns, buildId: "b1" });
      await handler.set("k", Promise.resolve(useCacheEntry({ timestamp: Date.now() - 10_000, revalidate: 5, expire: 30 })));
      const pttl = await client.pTTL(`${ns}:b1:u:k`);
      expect(pttl).toBeGreaterThan(19_000);
      expect(pttl).toBeLessThanOrEqual(21_000);
    });
  });

  describe("7-12 single-command writes", () => {
    it("[7-12] a skipped NX write leaves the existing entry (value, tags, TTL) unchanged", async () => {
      const ns = uniqueNamespace();
      const core = new LegacyCore(resolveConfig(testConfig({ client: client as never, namespace: ns })));
      await core.write("/page", { lastModified: 1, tags: ["a"], revalidate: false }, appPageValue("<p>a</p>"), { op: "set" });
      const ttl = await client.pTTL(entryKey(ns, "b1", "/page"));
      const took = await core.write("/page", { lastModified: 2, tags: ["b"], revalidate: 5 }, appPageValue("<p>b</p>"), { op: "reseed", onlyIfAbsent: true });
      expect(took).toBe("exists");
      const raw = await client.withTypeMapping({ 36: Buffer }).get(entryKey(ns, "b1", "/page"));
      const { meta, value } = await decodeEnvelope<{ tags: string[] }>(raw as unknown as Buffer);
      expect(meta.tags).toEqual(["a"]);
      expect((value as { html: string }).html).toBe("<p>a</p>");
      expect(await client.pTTL(entryKey(ns, "b1", "/page"))).toBeLessThanOrEqual(ttl);
    });

    it("[7-12] get never deletes a value written by another instance", async () => {
      const ns = uniqueNamespace();
      const { handler } = legacyHandler({ client: client as never, namespace: ns });
      const body = await encodeEnvelope({ lastModified: Date.now(), tags: [] }, appPageValue("<p>x</p>"));
      await client.set(entryKey(ns, "b1", "/page"), body, { expiration: { type: "EX", value: 600 } });
      expect(await handler.get("/page", { kind: "APP_PAGE" })).not.toBeNull();
      expect(await client.exists(entryKey(ns, "b1", "/page"))).toBe(1);
    });

    it("[7-12] use-cache get waits for the latest of two overlapping sets on the same key", async () => {
      const { handler: uc } = useCacheHandler({ client: client as never });
      let resolveSecond!: (e: ReturnType<typeof useCacheEntry>) => void;
      const first = uc.set("k", Promise.resolve(useCacheEntry({ value: "first" })));
      const second = uc.set("k", new Promise((r) => (resolveSecond = r)));
      await first; // its cleanup must not drop the pending marker of the second set
      const read = uc.get("k", []);
      setTimeout(() => resolveSecond(useCacheEntry({ value: "second" })), 100);
      try {
        expect(await readEntry(await read)).toBe("second");
      } finally {
        await second; // never leave a write running past the test (the client closes in afterAll)
      }
    });
  });

  describe("optional tag state TTL (HEXPIRE, Redis >= 7.4)", () => {
    it("tagStateTtlSeconds puts a TTL on the written fields, counted from the latest recorded time; invalidation works either way", async () => {
      const ns = uniqueNamespace();
      const warn: string[] = [];
      const { handler } = legacyHandler({ client: client as never, namespace: ns, tagStateTtlSeconds: 3600, logger: { warn: (m) => warn.push(String(m)) } });
      await handler.set("/p", appPageValue("<p>x</p>", ["t"]), {});
      await tick();
      await handler.revalidateTag("t", { expire: 600 });
      expect((await handler.get("/p", { kind: "APP_PAGE" }))?.lastModified).toBe(-1);
      const key = `${ns}:_tagstate`;
      if (version === "7.2") {
        expect(warn.some((w) => w.includes("HEXPIRE"))).toBe(true);
        await handler.revalidateTag("u");
        expect(warn.filter((w) => w.includes("HEXPIRE"))).toHaveLength(1);
      } else {
        const [stale, expired] = (await client.sendCommand(["HTTL", key, "FIELDS", "2", "s:t", "x:t"])) as number[];
        expect(stale).toBeGreaterThan(3600 + 590);
        expect(stale).toBeLessThanOrEqual(3600 + 600);
        expect(expired).toBe(stale);
        expect(warn).toEqual([]);
      }
      expect(await client.pTTL(key)).toBe(-1);
    });
  });

  describe("binary format on the wire", () => {
    it("stores raw bytes: a 100 KiB body costs about 100 KiB, not 133 KiB of base64 (compression none)", async () => {
      const ns = uniqueNamespace();
      const { handler } = legacyHandler({ client: client as never, namespace: ns, compression: "none" });
      const body = Buffer.alloc(100 * 1024, 1);
      await handler.set("/bin", { kind: "APP_ROUTE", body, status: 200, headers: {} }, {});
      expect(await client.strLen(entryKey(ns, "b1", "/bin"))).toBeLessThan(body.byteLength + 512);
      expect((await handler.get("/bin", { kind: "APP_ROUTE" }))?.value.body.equals(body)).toBe(true);
    });

    it("[A9] compressed entries are much smaller, and entries of every setting stay readable by every setting", async () => {
      const ns = uniqueNamespace();
      const html = Array.from({ length: 4000 }, (_, i) => `<p class="doc">paragraph ${i % 97} of the page</p>`).join("");
      const sizes: Record<string, number> = {};
      for (const compression of ["none", "gzip", "brotli"] as const) {
        const { handler } = legacyHandler({ client: client as never, namespace: ns, compression });
        await handler.set(`/${compression}`, appPageValue(html), {});
        sizes[compression] = await client.strLen(entryKey(ns, "b1", `/${compression}`));
      }
      expect(sizes.gzip!).toBeLessThan(sizes.none! / 2);
      expect(sizes.brotli!).toBeLessThan(sizes.none! / 2);
      for (const reader of ["none", "gzip", "brotli"] as const) {
        const { handler } = legacyHandler({ client: client as never, namespace: ns, compression: reader });
        for (const written of ["none", "gzip", "brotli"]) expect((await handler.get(`/${written}`, { kind: "APP_PAGE" }))?.value.html).toBe(html);
      }
    });
  });
});
