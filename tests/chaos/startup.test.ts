// Chaos C1 / C9 - start without a usable Redis (ROADMAP.md 7-2, A2). The fleet uses the 2.x README wiring
// (connectRedis waits at most 1s, handlers never send while the client is not ready, prerendered pages are
// served from the build output). Expected failures on 1.0.6 (endless connect wait, 404 on a miss).
import { describe, expect, it } from "vitest";
import { deadPort } from "../support/net";
import { directRedisUrl, launch, timedGet } from "./harness";

describe("C1 Redis absent at startup", () => {
  it("[7-2] C1 an instance with prewarm on becomes ready within 10s", async () => {
    const fleet = await launch("static-site", {
      instances: 1,
      redisUrl: `redis://127.0.0.1:${await deadPort()}`,
      env: { NRC_PREWARM: "1" },
      readyTimeoutMs: 10_000,
    });
    await fleet.stop();
  });

  it("[7-2] C1 the first page answers 200 within 2s (prewarm off, A2)", async () => {
    const fleet = await launch("static-site", { instances: 1, redisUrl: `redis://127.0.0.1:${await deadPort()}`, env: { NRC_PREWARM: "0" } });
    try {
      const first = await timedGet(fleet, "/", 5000);
      expect(first.status).toBe(200);
      expect(first.ms).toBeLessThan(2000);
    } finally {
      await fleet.stop();
    }
  });

  it("C1 routes that never touch the cache keep answering (harness sanity)", async () => {
    const fleet = await launch("static-site", { instances: 1, redisUrl: `redis://127.0.0.1:${await deadPort()}`, env: { NRC_PREWARM: "0" } });
    try {
      expect((await timedGet(fleet, "/api/nrc-test/stats", 5000)).status).toBe(200);
    } finally {
      await fleet.stop();
    }
  });
});

describe("C9 wrong Redis password", () => {
  it("[7-2] C9 the first page answers 200 within 2s", async () => {
    const fleet = await launch("static-site", { instances: 1, redisUrl: directRedisUrl.replace(":test@", ":wrong@"), env: { NRC_PREWARM: "0" } });
    try {
      const first = await timedGet(fleet, "/", 5000);
      expect(first.status).toBe(200);
      expect(first.ms).toBeLessThan(2000);
    } finally {
      await fleet.stop();
    }
  });
});
