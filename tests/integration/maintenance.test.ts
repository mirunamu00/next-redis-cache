// Old-build cleanup against real Redis (ROADMAP.md 5.5, 7-9, A5): OBJECT IDLETIME, batched UNLINK, TTL caps,
// and the key bound after many deployments.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redisVersionsUnderTest, startRedisContainer, type RedisServer } from "../support/redis-container";
import { connectTestClient, type TestRedisClient, type TrackedClient } from "../support/redis";
import { uniqueNamespace } from "../support/namespace";
import { appPageValue, fetchValue, legacyHandler, useCacheEntry, useCacheHandler } from "../support/handlers";
import { cleanupOldBuilds } from "../../src/maintenance";

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
    for await (const batch of client.scanIterator({ MATCH: `${ns}:*`, COUNT: 1000 })) keys.push(...batch.map(String));
    return keys.sort();
  };
  const unlinkCalls = async () => Number(/cmdstat_unlink:calls=(\d+)/.exec(await client.info("commandstats"))?.[1] ?? 0);

  it("[7-9] keeps keys of an old build that is still being served (recently accessed)", async () => {
    const ns = uniqueNamespace();
    for (const b of ["A", "P"]) await cleanupOldBuilds(client as never, { namespace: ns, buildId: b });
    await client.set(`${ns}:A:e:/page`, "old build, still serving", { expiration: { type: "EX", value: 600 } });
    await client.get(`${ns}:A:e:/page`); // an old pod read it just now (rolling update in progress)
    const r = await cleanupOldBuilds(client as never, { namespace: ns, buildId: "B" });
    expect(r.deferredBuilds).toEqual(["A"]);
    expect(await client.exists(`${ns}:A:e:/page`)).toBe(1);
    expect(await client.ttl(`${ns}:A:e:/page`)).toBeLessThanOrEqual(600);
  });

  it("[7-9] deletes an idle old build once its keys are older than minIdleSeconds", async () => {
    const ns = uniqueNamespace();
    for (const b of ["A", "P"]) await cleanupOldBuilds(client as never, { namespace: ns, buildId: b });
    await client.set(`${ns}:A:e:/page`, "x", { expiration: { type: "EX", value: 600 } });
    expect((await cleanupOldBuilds(client as never, { namespace: ns, buildId: "B", minIdleSeconds: 2 })).deferredBuilds).toEqual(["A"]);
    await new Promise((r) => setTimeout(r, 3100));
    expect((await cleanupOldBuilds(client as never, { namespace: ns, buildId: "B", minIdleSeconds: 2 })).removedBuilds).toEqual(["A"]);
    expect(await client.exists(`${ns}:A:e:/page`)).toBe(0);
  });

  it("[7-9] 10k keys of an old build go in UNLINK batches of at most 500", async () => {
    const ns = uniqueNamespace();
    const multi = client.multi();
    for (let i = 0; i < 10_000; i++) multi.set(`${ns}:old:e:k${i}`, "x", { expiration: { type: "EX", value: 600 } });
    await multi.exec();
    const before = await unlinkCalls();
    const r = await cleanupOldBuilds(client as never, { namespace: ns, buildId: "B", keepPrevious: 0, minIdleSeconds: 0 });
    expect(r.deleted).toBe(10_000);
    expect((await unlinkCalls()) - before).toBeGreaterThanOrEqual(20);
    expect(await nsKeys(ns)).toEqual([`${ns}:_builds`]);
  });

  it("removes idle 1.x layouts ({ns}:{build}:{key} and its tag hashes) and keeps the 2.x tag state", async () => {
    const ns = uniqueNamespace();
    await client.set(`${ns}:sha1:/about`, "{}", { expiration: { type: "EX", value: 600 } });
    await client.hSet(`${ns}:sha1:_tags`, { "/about": "[]" });
    await client.hSet(`${ns}:_revalidated`, { t: "1" });
    await client.hSet(`${ns}:_tagstate`, { "x:t": "1" });
    const r = await cleanupOldBuilds(client as never, { namespace: ns, buildId: "B", minIdleSeconds: 0 });
    expect(r.removedBuilds.sort()).toEqual(["_revalidated", "sha1"]);
    expect(await nsKeys(ns)).toEqual([`${ns}:_builds`, `${ns}:_tagstate`]);
  });

  it("[A5] after 10 deployments: keys <= (kept builds x entries) + shared keys; only _tagstate and _builds have no TTL", async () => {
    const ns = uniqueNamespace();
    const PAGES = 20;
    for (let d = 0; d < 10; d++) {
      const buildId = `b${d}`;
      const { handler } = legacyHandler({ client: client as never, namespace: ns, buildId });
      const { handler: uc } = useCacheHandler({ client: client as never, namespace: ns, buildId });
      for (let i = 0; i < PAGES; i++) await handler.set(`/p${i}`, appPageValue(`<p>${d}</p>`, [`t${i % 3}`]), { cacheControl: { revalidate: false } });
      await handler.set("f", fetchValue(), { fetchCache: true, tags: ["t0"] });
      await uc.set("k", Promise.resolve(useCacheEntry({ tags: ["t1"] })));
      await handler.revalidateTag(`t${d % 3}`);
      // a deployment: the new build starts and cleans up (old builds already idle long enough)
      await cleanupOldBuilds(client as never, { namespace: ns, buildId, minIdleSeconds: 0 });
    }
    const keys = await nsKeys(ns);
    const perBuild = PAGES + 2;
    expect(keys.length).toBeLessThanOrEqual(2 * perBuild + 2);
    expect(new Set(keys.filter((k) => !k.includes(":_")).map((k) => k.split(":")[1]))).toEqual(new Set(["b8", "b9"]));
    for (const key of keys) {
      const ttl = await client.ttl(key);
      if (key.endsWith(":_tagstate") || key.endsWith(":_builds")) expect(ttl, key).toBe(-1);
      else expect(ttl, key).toBeGreaterThan(0);
    }
    // the previous build is capped at one day
    expect(await client.ttl(`${ns}:b8:e:/p0`)).toBeLessThanOrEqual(24 * 3600);
  });
});
