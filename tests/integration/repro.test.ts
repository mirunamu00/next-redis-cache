// Reproductions against real Redis (ROADMAP.md 7-1, 7-4, 7-5, 7-6, 7-9, 7-11, 7-12), once per Redis
// version under test. Each asserts the correct behavior and is an expected failure on 1.0.6
// (tests/support/repro.ts). Tests that pin behavior 1.0.6 already gets right use plain `it`.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redisVersionsUnderTest, startRedisContainer, type RedisServer } from "../support/redis-container";
import { connectTestClient, type TestRedisClient, type TrackedClient } from "../support/redis";
import { uniqueNamespace } from "../support/namespace";
import { waitFor } from "../support/wait-for";
import { appPageValue, fetchValue, freshInstrumentation, freshLegacy, readEntry, useCacheEntry } from "../support/handlers";
import { itRepro } from "../support/repro";
import { createUseCacheHandler } from "../../src/use-cache-handler";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/next-build/", import.meta.url));
const YEAR = 365 * 24 * 3600;

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

  /** Shared-hash options used by both handlers, as the README recommends. */
  const options = (ns: string) => ({
    client: client as never,
    keyPrefix: `${ns}:`,
    sharedTagsKey: "_tags",
    sharedTagsTtlKey: "_tagTtls",
    revalidatedTagsKey: "_revalidated",
  });

  describe("7-1 updateTags durations", () => {
    it("[7-1] updateTags without durations expires tagged entries (immediate expiry works)", async () => {
      const uc = createUseCacheHandler(options(uniqueNamespace()));
      await uc.set("k", Promise.resolve(useCacheEntry({ tags: ["t"], timestamp: Date.now() - 1000 })));
      await uc.updateTags(["t"]);
      expect(await uc.get("k", [])).toBeUndefined();
    });

    itRepro("7-1", "an entry written after updateTags(tags, { expire: 1y }) is readable", async () => {
      const uc = createUseCacheHandler(options(uniqueNamespace()));
      await uc.updateTags(["t"], { expire: YEAR });
      await new Promise((r) => setTimeout(r, 5));
      await uc.set("k", Promise.resolve(useCacheEntry({ value: "fresh", tags: ["t"] })));
      expect(await readEntry(await uc.get("k", []))).toBe("fresh");
    });

    itRepro("7-1", "getExpiration after updateTags(tags, { expire }) never reports a future time", async () => {
      const uc = createUseCacheHandler(options(uniqueNamespace()));
      await uc.updateTags(["t"], { expire: YEAR });
      expect(await uc.getExpiration(["t"])).toBeLessThanOrEqual(Date.now());
    });

    itRepro("7-1", "a legacy entry written after a use-cache updateTags(tags, { expire }) is readable (shared hash)", async () => {
      const ns = uniqueNamespace();
      const uc = createUseCacheHandler(options(ns));
      const { handler } = await freshLegacy(options(ns));
      await uc.updateTags(["t"], { expire: YEAR });
      await new Promise((r) => setTimeout(r, 5));
      await handler.set("/page", appPageValue("<p>fresh</p>", ["t"]), { revalidate: false });
      expect(await handler.get("/page", { softTags: [] })).not.toBeNull();
    });

    itRepro("7-1", "a future tag timestamp left by 1.0.x heals: an entry written after the next read is a hit", async () => {
      const ns = uniqueNamespace();
      const uc = createUseCacheHandler(options(ns));
      await client.hSet(`${ns}:_revalidated`, "t", String(Date.now() + YEAR * 1000));
      await uc.set("k", Promise.resolve(useCacheEntry({ value: "old", tags: ["t"], timestamp: Date.now() - 1000 })));
      expect(await uc.get("k", []), "an entry older than the heal stays a miss").toBeUndefined();
      await new Promise((r) => setTimeout(r, 5));
      await uc.set("k", Promise.resolve(useCacheEntry({ value: "fresh", tags: ["t"] })));
      expect(await readEntry(await uc.get("k", []))).toBe("fresh");
      expect(Number(await client.hGet(`${ns}:_revalidated`, "t"))).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("7-4 prewarm from build output", () => {
    const prewarm = async (ns: string, root = FIXTURE_ROOT) => {
      const { registerInitialCache } = await freshInstrumentation();
      const { Handler } = await freshLegacy(options(ns));
      const cwd = process.cwd();
      process.chdir(root);
      try {
        return await registerInitialCache(Handler, { setOnlyIfNotExists: true });
      } finally {
        process.chdir(cwd);
      }
    };

    it("[7-4] prewarms the /about page (baseline)", async () => {
      const ns = uniqueNamespace();
      await prewarm(ns);
      expect(await client.exists(`${ns}:/about`)).toBe(1);
    });

    itRepro("7-4", "segment keys match the meta segmentPaths (/_tree, /about/__PAGE__)", async () => {
      const ns = uniqueNamespace();
      await prewarm(ns);
      const stored = JSON.parse((await client.get(`${ns}:/about`))!) as { value: { segmentData: Record<string, string> } };
      expect(Object.keys(stored.value.segmentData).sort()).toEqual(["/_full", "/_tree", "/about/__PAGE__"]);
    });

    itRepro("7-4", "the root page is stored under Next's cache key /index", async () => {
      const ns = uniqueNamespace();
      await prewarm(ns);
      expect(await client.exists(`${ns}:/index`)).toBe(1);
    });

    itRepro("7-4", "APP_ROUTE outputs (dataRoute null, e.g. /icon) are prewarmed", async () => {
      const ns = uniqueNamespace();
      await prewarm(ns);
      expect(await client.exists(`${ns}:/icon`)).toBe(1);
    });

    itRepro("7-4", "the not-found page is prewarmed and keeps status 404 from its meta", async () => {
      const ns = uniqueNamespace();
      await prewarm(ns);
      const raw = await client.get(`${ns}:/_not-found`);
      expect(raw, "/_not-found prewarmed").not.toBeNull();
      expect((JSON.parse(raw!) as { value: { status?: number } }).value.status).toBe(404);
    });

    itRepro("7-4", "APP_ROUTE entries keep status and headers from their meta", async () => {
      const ns = uniqueNamespace();
      await prewarm(ns);
      const raw = await client.get(`${ns}:/icon`);
      expect(raw, "/icon prewarmed").not.toBeNull();
      const { value } = JSON.parse(raw!) as { value: { kind: string; status?: number; headers?: Record<string, string> } };
      expect(value.kind).toBe("APP_ROUTE");
      expect(value.status).toBe(200);
      expect(value.headers?.["content-type"]).toBe("image/png");
    });

    itRepro("7-4", "a partially prerendered page keeps its postponed state from the meta", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "nrc-ppr-"));
      try {
        cpSync(FIXTURE_ROOT, root, { recursive: true });
        const metaPath = path.join(root, ".next", "server", "app", "about.meta");
        writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, "utf8")), postponed: "ppr-state" }));
        const ns = uniqueNamespace();
        await prewarm(ns, root);
        const stored = JSON.parse((await client.get(`${ns}:/about`))!) as { value: { postponed?: string } };
        expect(stored.value.postponed).toBe("ppr-state");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("7-5 tag metadata lifetime", () => {
    itRepro("7-5", "tag and TTL hash fields disappear with the entries they describe", async () => {
      const ns = uniqueNamespace();
      const { handler } = await freshLegacy(options(ns));
      // FETCH revalidate=1 -> expire age floor(1.5)=1 -> EX 1 second
      for (let i = 0; i < 50; i++) await handler.set(`/f${i}`, fetchValue("{}", ["t"], 1), { tags: ["t"], revalidate: 1 });
      await waitFor(async () => (await client.exists(`${ns}:/f0`)) === 0, { timeout: 4000, message: "entries expired" });
      await waitFor(async () => (await client.exists(`${ns}:/f49`)) === 0, { timeout: 4000, message: "entries expired" });
      expect(await client.hLen(`${ns}:_tags`)).toBe(0);
      expect(await client.hLen(`${ns}:_tagTtls`)).toBe(0);
    });

    itRepro("7-5", "one corrupted tag field does not stop revalidateTag for the other entries", async () => {
      const ns = uniqueNamespace();
      const { handler } = await freshLegacy(options(ns));
      await client.hSet(`${ns}:_tags`, "/broken", "{not json");
      await handler.set("/page", appPageValue("<p>x</p>", ["t"]), { revalidate: false });
      await handler.revalidateTag("t");
      expect(await handler.get("/page", { softTags: [] })).toBeNull();
    });
  });

  describe("7-6 legacy revalidateTag semantics", () => {
    itRepro("7-6", "revalidateTag(tag, { expire }) keeps the entry servable while it is regenerated (SWR)", async () => {
      const ns = uniqueNamespace();
      const { handler } = await freshLegacy(options(ns));
      await handler.set("/page", appPageValue("<p>old</p>", ["t"]), { revalidate: false });
      await handler.revalidateTag("t", { expire: 3600 });
      expect(await handler.get("/page", { softTags: [] })).not.toBeNull();
    });

    itRepro("7-6", "an entry rendered before an explicit-tag invalidation is not served as fresh afterwards", async () => {
      const ns = uniqueNamespace();
      const { handler } = await freshLegacy(options(ns));
      const renderStarted = Date.now() - 1000;
      await handler.revalidateTag("t");
      // A slow render that started before the invalidation finishes and stores its (old) result
      await handler.set("/page", appPageValue("<p>old</p>", ["t"]), { revalidate: false, internal_lastModified: renderStarted });
      expect(await handler.get("/page", { softTags: [] })).toBeNull();
    });
  });

  describe("7-9 cleanupOldBuildKeys", () => {
    itRepro("7-9", "deletes in batches of at most 500 keys", async () => {
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
      const { cleanupOldBuildKeys } = await freshInstrumentation();
      const { deleted } = await cleanupOldBuildKeys({ redisUrl: server.url, patterns: [{ scan: `${ns}:*`, keepPrefix: `${ns}:new:` }] });
      expect(deleted).toBe(10_000);
      expect((await calls()) - before).toBeGreaterThanOrEqual(20);
    });

    itRepro("7-9", "overlapping patterns delete and count every key once", async () => {
      const ns = uniqueNamespace();
      for (let i = 0; i < 100; i++) await client.set(`${ns}:old:k${i}`, "x", { expiration: { type: "EX", value: 600 } });
      const { cleanupOldBuildKeys } = await freshInstrumentation();
      const { deleted } = await cleanupOldBuildKeys({ redisUrl: server.url, patterns: [{ scan: `${ns}:*` }, { scan: `${ns}:old:*` }] });
      expect(deleted).toBe(100);
    });

    itRepro("7-9", "keeps keys of an old build that is still being served (recently accessed)", async () => {
      const ns = uniqueNamespace();
      await client.set(`${ns}:A:/page`, "old build, still serving", { expiration: { type: "EX", value: 600 } });
      await client.get(`${ns}:A:/page`); // an old pod read it just now (rolling update in progress)
      const { cleanupOldBuildKeys } = await freshInstrumentation();
      await cleanupOldBuildKeys({ redisUrl: server.url, patterns: [{ scan: `${ns}:*`, keepPrefix: `${ns}:B:` }] });
      expect(await client.exists(`${ns}:A:/page`)).toBe(1);
    });
  });

  describe("7-11 TTL", () => {
    itRepro("7-11", "APP_ROUTE revalidate=5 (cacheControl) has PTTL of about 7.5s", async () => {
      const ns = uniqueNamespace();
      const { handler } = await freshLegacy(options(ns));
      await handler.set("/api/timed", { kind: "APP_ROUTE", body: Buffer.from("{}"), status: 200, headers: {} }, {
        cacheControl: { revalidate: 5, expire: undefined },
      });
      const pttl = await client.pTTL(`${ns}:/api/timed`);
      expect(pttl).toBeGreaterThan(6_000);
      expect(pttl).toBeLessThanOrEqual(7_500);
    });
  });

  describe("7-12 non-atomic writes", () => {
    itRepro("7-12", "a skipped NX write leaves the existing entry's tag metadata unchanged", async () => {
      const ns = uniqueNamespace();
      const { handler } = await freshLegacy(options(ns));
      await handler.set("/page", appPageValue("<p>a</p>", ["a"]), { revalidate: false });
      await handler.set("/page", appPageValue("<p>b</p>", ["b"]), { revalidate: false, setOnlyIfNotExists: true });
      expect(JSON.parse((await client.hGet(`${ns}:_tags`, "/page"))!)).toEqual(["a"]);
    });

    itRepro("7-12", "get does not delete a value whose tag metadata is still being written by another instance", async () => {
      const ns = uniqueNamespace();
      const { handler } = await freshLegacy(options(ns));
      // Another pod's SET landed; its HSET of the tag metadata has not yet
      const stored = { lastModified: Date.now(), value: appPageValue("<p>x</p>"), tags: [], lifespan: null };
      await client.set(`${ns}:/page`, JSON.stringify({ ...stored, value: { ...stored.value, rscData: "cnNj", segmentData: {} } }), {
        expiration: { type: "EX", value: 600 },
      });
      await handler.get("/page", { softTags: [] });
      expect(await client.exists(`${ns}:/page`)).toBe(1);
    });

    itRepro("7-12", "use-cache get waits for the latest of two overlapping sets on the same key", async () => {
      const uc = createUseCacheHandler(options(uniqueNamespace()));
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
});
