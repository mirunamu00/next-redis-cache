// Chaos C3 (Redis unresponsive), C4 (latency 300 ms + jitter), C10 (WRONGTYPE on the shared tag state) -
// ROADMAP.md A3, I1..I4. static-site through this worker's toxiproxy proxy, prewarm off: every prerendered
// page has an answer from the build output, so Redis trouble may cost latency but never a failed response.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@redis/client";
import type { ProxyHandle } from "../support/toxiproxy";
import { waitFor } from "../support/wait-for";
import { directRedisUrl, launch, redisProxy, sleep, timedGet, traffic, unhandledTotal, type Fleet } from "./harness";

const DOCS = ["/about", "/docs/guide/doc-0", "/docs/reference/doc-1", "/docs/tutorial/doc-2", "/docs/ops/doc-3", "/docs/api/section-1/doc-4", "/docs/concepts/doc-5"];
const READ_MS = 1000;
const OPEN_MS = 5000;

let proxy: ProxyHandle;
let fleet: Fleet;
let admin: ReturnType<typeof createClient>;

interface Stats {
  events: Record<string, number>;
  unhandledRejections: number;
}

async function events(): Promise<Record<string, number>> {
  const all = (await fleet.stats()) as Stats[];
  const sum: Record<string, number> = {};
  for (const s of all) for (const [k, v] of Object.entries(s.events)) sum[k] = (sum[k] ?? 0) + v;
  return sum;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

beforeAll(async () => {
  proxy = await redisProxy();
  fleet = await launch("static-site", { instances: 1, redisUrl: proxy.url, env: { NRC_READ_MS: String(READ_MS), NRC_OPEN_MS: String(OPEN_MS) } });
  admin = createClient({ url: directRedisUrl });
  admin.on("error", () => {});
  await admin.connect();
  // warm: first answers come from the build output and are re-seeded, then served from Redis
  for (const p of DOCS) await (await fleet.request(p)).arrayBuffer();
  await waitFor(async () => ((await events()).reseed ?? 0) >= DOCS.length, { timeout: 10_000, message: "pages re-seeded" });
});

afterEach(async () => {
  await proxy.clear();
});

afterAll(async () => {
  await fleet?.stop();
  admin?.destroy();
  await proxy?.destroy();
});

describe("C3 Redis stops answering (connection open, no replies)", () => {
  it("[A3] the first request waits at most about readMs, later ones answer at build-output speed; hits resume after recovery", async () => {
    const healthy: number[] = [];
    for (let i = 0; i < 14; i++) healthy.push((await timedGet(fleet, DOCS[i % DOCS.length]!, 10_000)).ms);
    const before = await unhandledTotal(fleet);

    await proxy.latency(30_000, 0, "downstream"); // replies are held back: Redis looks unresponsive
    const first = await timedGet(fleet, "/docs/guide/doc-0", 10_000);
    expect(first.status).toBe(200);
    expect(first.ms).toBeLessThan(READ_MS + 1500);

    const open: number[] = [];
    for (let i = 0; i < 14; i++) {
      const r = await timedGet(fleet, DOCS[i % DOCS.length]!, 10_000);
      expect(r.status).toBe(200);
      open.push(r.ms);
    }
    // A3: at most 50 ms extra per request while the circuit is open
    expect(median(open) - median(healthy)).toBeLessThan(50);
    expect((await events())["circuit:open"]).toBeGreaterThanOrEqual(1);

    await proxy.clear();
    const hits = (await events()).hit ?? 0;
    const load = traffic(fleet, DOCS, { concurrency: 2 });
    await waitFor(async () => ((await events()).hit ?? 0) > hits + 5, { timeout: OPEN_MS + 10_000, message: "Redis hits resume (I4)" });
    const result = await load.stop();
    expect(result.failures).toEqual([]);
    expect((await unhandledTotal(fleet)) - before).toBe(0);
    expect(fleet.crashed).toEqual([]);
  });
});

describe("C4 latency 300 ms with jitter", () => {
  it("every response stays 200 and bounded; the circuit stays closed (I1, I3)", async () => {
    const opens = (await events())["circuit:open"] ?? 0;
    await proxy.latency(300, 100, "downstream");
    const load = traffic(fleet, DOCS, { concurrency: 4 });
    await sleep(5000);
    const result = await load.stop();
    expect(result.failures).toEqual([]);
    expect(result.requests).toBeGreaterThan(10);
    // two round trips per page at most, each under readMs
    expect(result.maxLatencyMs).toBeLessThan(2 * READ_MS + 1000);
    expect((await events())["circuit:open"] ?? 0).toBe(opens);
  });
});

describe("C10 WRONGTYPE: the tag state key holds the wrong type", () => {
  it("pages keep answering 200 and invalidations fail without crashing (I1, I2)", async () => {
    const tagKey = `${fleet.namespace}:_tagstate`;
    await admin.del(tagKey);
    await admin.set(tagKey, "not a hash");
    const before = await unhandledTotal(fleet);
    try {
      const load = traffic(fleet, DOCS, { concurrency: 4 });
      await sleep(3000);
      const result = await load.stop();
      expect(result.failures).toEqual([]);
      expect((await events()).error ?? 0).toBeGreaterThan(0);
      expect((await unhandledTotal(fleet)) - before).toBe(0);
      expect(fleet.crashed).toEqual([]);
    } finally {
      await admin.del(tagKey);
    }
  });
});
