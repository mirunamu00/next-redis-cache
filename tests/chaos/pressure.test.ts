// Chaos C7 (eviction pressure on a production-like Redis) and C14 (clock skew between instances) -
// ROADMAP.md 6.5, section 9. C7 requires `npm run infra:up -- prodlike`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@redis/client";
import { waitFor } from "../support/wait-for";
import { directRedisUrl, launch, sleep, traffic, unhandledTotal, type Fleet } from "./harness";

const PRODLIKE_URL = `redis://default:test@127.0.0.1:${process.env.NRC_PRODLIKE_PORT ?? "6390"}`;

describe("C7 eviction pressure (maxmemory far below one build, volatile-lru)", () => {
  let admin: ReturnType<typeof createClient>;
  let fleet: Fleet;
  let maxmemory: string;

  beforeAll(async () => {
    admin = createClient({ url: PRODLIKE_URL });
    admin.on("error", () => {});
    await admin.connect();
    maxmemory = String((await admin.configGet("maxmemory")).maxmemory);
    await admin.configSet("maxmemory", "6mb");
    fleet = await launch("static-site", { instances: 2, redisUrl: PRODLIKE_URL, env: { NRC_PREWARM: "1" } });
  });

  afterAll(async () => {
    await fleet?.stop();
    await admin?.configSet("maxmemory", maxmemory);
    admin?.destroy();
  });

  it("every page answers 200, entries are evicted, the tag state is never evicted (I1, I2)", async () => {
    const paths = (await (await fleet.request("/sitemap.xml")).text()).match(/<loc>[^<]+<\/loc>/g)!.map((l) => new URL(l.slice(5, -6)).pathname);
    await admin.hSet(`${fleet.namespace}:_tagstate`, { "x:marker": String(Date.now()) });
    const evictedBefore = Number(/evicted_keys:(\d+)/.exec(await admin.info("stats"))?.[1] ?? 0);
    const before = await unhandledTotal(fleet);
    const load = traffic(fleet, paths, { concurrency: 6 });
    await sleep(8000);
    const result = await load.stop();
    expect(result.failures).toEqual([]);
    expect(result.requests).toBeGreaterThan(paths.length);
    const evicted = Number(/evicted_keys:(\d+)/.exec(await admin.info("stats"))?.[1] ?? 0) - evictedBefore;
    expect(evicted).toBeGreaterThan(0);
    expect(await admin.hGet(`${fleet.namespace}:_tagstate`, "x:marker")).not.toBeNull();
    expect((await unhandledTotal(fleet)) - before).toBe(0);
    expect(fleet.crashed).toEqual([]);
  });
});

describe("C14 clock skew between instances", () => {
  let fleet: Fleet;

  beforeAll(async () => {
    fleet = await launch("full-legacy", { instances: 1 });
    await fleet.start("A", { TEST_CLOCK_OFFSET_MS: "-3000" }); // the second instance runs 3 s behind
  });

  afterAll(async () => {
    await fleet?.stop();
  });

  const versionOn = async (url: string) => {
    const res = await fetch(`${url}/pinned/6`);
    const body = await res.text();
    return { status: res.status, version: Number(/data-version="(\d+)"/.exec(body)?.[1]), cache: res.headers.get("x-nextjs-cache") };
  };

  it("an invalidation made by an instance 3 s behind still reaches entries written more than 3 s earlier (I1, I5)", async () => {
    const [ahead, behind] = fleet.instances;
    const origin = fleet.origin!;
    // settle a runtime-rendered entry written by the instance with the correct clock
    origin.bump("pinned-6");
    await fetch(`${ahead!.url}/api/revalidate?tag=pinned-6&profile=none`, { method: "POST" });
    await waitFor(async () => (await versionOn(ahead!.url)).version === 2 && (await versionOn(ahead!.url)).cache === "HIT", {
      timeout: 15_000,
      interval: 200,
      message: "fresh entry written by the instance with the correct clock",
    });
    await sleep(5000); // more than the skew
    const admin = createClient({ url: directRedisUrl });
    admin.on("error", () => {});
    await admin.connect();
    const field = () => admin.hGet(`${fleet.namespace}:_tagstate`, "x:pinned-6");
    const previous = await field();
    origin.bump("pinned-6");
    await fetch(`${behind!.url}/api/revalidate?tag=pinned-6&profile=none`, { method: "POST" });
    // Next applies the invalidation after the response: wait until it reached Redis
    const recorded = Number(await waitFor(async () => {
      const v = await field();
      return v !== previous ? v : undefined;
    }, { message: "the skewed instance's invalidation reached Redis" }));
    admin.destroy();
    expect(recorded).toBeLessThan(Date.now() - 2000); // recorded with the skewed clock
    const first = await versionOn(ahead!.url);
    expect(first.status).toBe(200);
    expect(first.cache === "HIT" && first.version === 2, `x-nextjs-cache ${first.cache}, version ${first.version}`).toBe(false);
    await waitFor(async () => (await versionOn(ahead!.url)).version === 3, { timeout: 15_000, interval: 200, message: "new data after the skewed invalidation" });
    expect(fleet.crashed).toEqual([]);
  });
});
