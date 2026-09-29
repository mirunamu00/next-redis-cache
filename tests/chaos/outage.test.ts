// Chaos C2 / C5 - Redis disappears or resets connections under traffic (ROADMAP.md 7-3, A4).
// full-cc through this worker's toxiproxy proxy: /dyn/* runs the "use cache" handler on every request.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@redis/client";
import type { ProxyHandle } from "../support/toxiproxy";
import { itRepro } from "../support/repro";
import { waitFor } from "../support/wait-for";
import { directRedisUrl, launch, redisProxy, sleep, traffic, unhandledTotal, type Fleet } from "./harness";

const PATHS = ["/", "/uc/1", "/ppr", "/dyn/1", "/dyn/2", "/dyn/3", "/dyn/4", "/dyn/5"];

let proxy: ProxyHandle;
let fleet: Fleet;
let admin: ReturnType<typeof createClient>;

beforeAll(async () => {
  proxy = await redisProxy();
  fleet = await launch("full-cc", { redisUrl: proxy.url });
  admin = createClient({ url: directRedisUrl });
  admin.on("error", () => {});
  await admin.connect();
  for (const p of PATHS) await (await fleet.request(p)).arrayBuffer();
});

afterEach(async () => {
  await proxy.clear();
});

afterAll(async () => {
  await fleet?.stop();
  admin?.destroy();
  await proxy?.destroy();
});

async function getCalls(): Promise<number> {
  const info = await admin.info("commandstats");
  return Number(/cmdstat_get:calls=(\d+)/.exec(info)?.[1] ?? 0);
}

async function useCacheHits(): Promise<number> {
  const all = (await fleet.stats()) as Array<{ stats: { useCache: { hit: number } } }>;
  return all.reduce((n, s) => n + s.stats.useCache.hit, 0);
}

interface Outcome {
  failures: string[];
  crashed: string[];
  unhandled: number;
  hitsResumedMs: number;
}

/** Runs traffic, applies `fault` for 3s, lifts it, waits for use-cache hits to resume, then reports. */
async function scenario(fault: () => Promise<unknown>): Promise<Outcome> {
  const load = traffic(fleet, PATHS);
  await sleep(1000);
  await fault();
  await sleep(3000);
  await proxy.clear();
  const recoveredAt = Date.now();
  const hitsAtRecovery = await useCacheHits();
  await waitFor(async () => (await useCacheHits()) > hitsAtRecovery + 5, { timeout: 10_000, message: "use-cache hits resume (I4)" });
  const hitsResumedMs = Date.now() - recoveredAt;
  const result = await load.stop();
  return { failures: result.failures, crashed: fleet.crashed.map((m) => m.id), unhandled: await unhandledTotal(fleet), hitsResumedMs };
}

describe("C2 Redis unreachable during traffic", () => {
  let outcome: Outcome;
  beforeAll(async () => {
    const before = await unhandledTotal(fleet);
    outcome = await scenario(() => proxy.disable());
    outcome.unhandled -= before;
  });

  it("C2 every response stays 200 and hits resume within 10s (I1, I4)", () => {
    expect(outcome.failures).toEqual([]);
    expect(outcome.hitsResumedMs).toBeLessThan(10_000);
    expect(outcome.crashed).toEqual([]);
  });

  itRepro("7-3", "C2 no unhandled rejections (I2)", () => {
    expect(outcome.unhandled).toBe(0);
  });

  itRepro("7-3", "C2 requests made during the outage are not replayed against Redis after recovery (A4)", async () => {
    await proxy.disable();
    await waitFor(async () => {
      const r = await fleet.request("/dyn/9");
      await r.arrayBuffer();
      return r.status === 200;
    });
    for (let i = 0; i < 50; i++) await (await fleet.request(`/dyn/${100 + i}`)).arrayBuffer();
    const before = await getCalls();
    await proxy.enable();
    await sleep(3000); // no traffic now: any GET that arrives was queued during the outage
    expect((await getCalls()) - before).toBe(0);
  });
});

describe("C5 connections reset by peer", () => {
  let outcome: Outcome;
  beforeAll(async () => {
    const before = await unhandledTotal(fleet);
    outcome = await scenario(() => proxy.resetPeer(0));
    outcome.unhandled -= before;
  });

  it("C5 every response stays 200 and hits resume within 10s (I1, I4)", () => {
    expect(outcome.failures).toEqual([]);
    expect(outcome.hitsResumedMs).toBeLessThan(10_000);
    expect(outcome.crashed).toEqual([]);
  });

  itRepro("7-3", "C5 no unhandled rejections (I2)", () => {
    expect(outcome.unhandled).toBe(0);
  });
});
