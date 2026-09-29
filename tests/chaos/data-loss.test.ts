// Chaos C6 (cache wiped under traffic) and C13 (invalidation during a slow render) - ROADMAP.md 7-6.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@redis/client";
import { dropNamespace } from "../../scripts/fleet.mjs";
import { directRedisUrl, launch, sleep, traffic, type Fleet } from "./harness";

let admin: ReturnType<typeof createClient>;

beforeAll(async () => {
  admin = createClient({ url: directRedisUrl });
  admin.on("error", () => {});
  await admin.connect();
});

afterAll(() => {
  admin?.destroy();
});

describe("C6 the cache is wiped (FLUSHALL of the namespace) under traffic", () => {
  it("[7-6] C6 prerendered docs keep answering 200 (I1)", async () => {
    const fleet = await launch("static-site", { env: { NRC_PREWARM: "1" } });
    try {
      const paths = ["/about", "/docs/guide/doc-0", "/docs/reference/doc-1", "/docs/tutorial/doc-2", "/docs/ops/doc-3", "/docs/api/section-1/doc-4", "/docs/concepts/doc-5"];
      const load = traffic(fleet, paths);
      await sleep(1000);
      await dropNamespace(directRedisUrl, fleet.namespace);
      await sleep(3000);
      const result = await load.stop();
      expect(result.failures).toEqual([]);
    } finally {
      await fleet.stop();
    }
  });
});

describe("C13 invalidation lands while a slow render is in flight", () => {
  it("[7-6] C13 the render that started before the invalidation is not served as fresh afterwards (I5)", async () => {
    const fleet: Fleet = await launch("full-legacy", { instances: 1 });
    try {
      const origin = fleet.origin!;
      origin.setDelay("race-k1", 1500);
      const slow = fleet.request("/race/k1").then(async (r) => ({ status: r.status, body: await r.text() }));
      await sleep(300);
      origin.bump("race-k1"); // the data changes ...
      const inv = await fleet.request("/api/revalidate?tag=race-k1&profile=none", { method: "POST" }); // ... and is invalidated
      expect(inv.status).toBe(200);
      const first = await slow; // finishes with the version it read before the change
      expect(first.body).toContain('data-version="1"');
      origin.setDelay("race-k1", 0);

      const next = await fleet.request("/race/k1");
      const body = await next.text();
      const cache = next.headers.get("x-nextjs-cache");
      // Old data may only come back marked stale (being regenerated), never as a fresh hit
      expect(cache === "HIT" && body.includes('data-version="1"'), `x-nextjs-cache ${cache}, ${/data-version="(\d+)"/.exec(body)?.[0]}`).toBe(false);
    } finally {
      await fleet.stop();
    }
  });
});
