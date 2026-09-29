// Regressions on static-site (ROADMAP.md 7-4, A2, A6). 7-4 is fixed since 1.1.0 (1.0.6 stored segment keys
// without the leading slash, so the prefetch answered 404); A2 since 2.0 (build-output fallback).
import { createClient } from "@redis/client";
import { e2eRedisUrl, expect, getPage, launchFleet, segmentPrefetch, test } from "../fixtures";
import { waitFor } from "../../support/wait-for";

test.describe("static-site regressions", () => {
  test("[7-4] segment prefetch of a prewarmed page answers 200 (A6)", async ({ fleet }) => {
    for (const p of ["/", "/about", "/docs/guide/doc-6"]) {
      expect((await getPage(fleet, p)).status, p).toBe(200);
      expect((await segmentPrefetch(fleet, p, "/_tree")).status, `${p} /_tree`).toBe(200);
    }
  });

  test("[A2] prerendered docs pages answer 200 on an empty Redis (no prewarm)", async () => {
    const fleet = await launchFleet("static-site", { instances: 1, env: { NRC_PREWARM: "0" } });
    try {
      for (const p of ["/docs/guide/doc-0", "/docs/api/section-1/doc-4"]) expect((await getPage(fleet, p)).status, p).toBe(200);
    } finally {
      await fleet.stop();
    }
  });

  test("[A6] pages served from the build output are re-seeded, and their segment prefetch answers 200 (no prewarm)", async () => {
    const fleet = await launchFleet("static-site", { instances: 1, env: { NRC_PREWARM: "0" } });
    const redis = createClient({ url: e2eRedisUrl });
    redis.on("error", () => {});
    await redis.connect();
    try {
      for (const p of ["/about", "/docs/ops/doc-3"]) {
        expect((await getPage(fleet, p)).status, p).toBe(200);
        const key = `${fleet.namespace}:A:e:${p}`;
        await waitFor(async () => (await redis.exists(key)) === 1, { message: `${p} re-seeded into Redis` });
        expect((await segmentPrefetch(fleet, p, "/_tree")).status, `${p} /_tree`).toBe(200);
        expect((await getPage(fleet, p)).status, p).toBe(200);
      }
      const [stats] = (await fleet.stats()) as Array<{ events: Record<string, number> }>;
      expect(stats!.events["fallback:fresh"]).toBeGreaterThanOrEqual(2);
      expect(stats!.events.reseed).toBeGreaterThanOrEqual(2);
      expect(stats!.events.hit).toBeGreaterThanOrEqual(2);
    } finally {
      redis.destroy();
      await fleet.stop();
    }
  });
});
