// Chaos C1 / C9 - start without a usable Redis (ROADMAP.md 7-2, A2). The fleet uses the README
// wiring (NRC_API=v1): the onCreation hook awaits client.connect() and instrumentation awaits the
// prewarm. Expected failures on 1.0.6.
import { describe, expect, it } from "vitest";
import { deadPort } from "../support/net";
import { itRepro } from "../support/repro";
import { directRedisUrl, launch, timedGet } from "./harness";

describe("C1 Redis absent at startup", () => {
  itRepro("7-2", "C1 an instance with prewarm on becomes ready within 10s", async () => {
    const fleet = await launch("static-site", {
      instances: 1,
      redisUrl: `redis://127.0.0.1:${await deadPort()}`,
      env: { NRC_PREWARM: "1" },
      readyTimeoutMs: 10_000,
    });
    await fleet.stop();
  });

  itRepro("7-2", "C1 the first page answers 200 within 2s (prewarm off)", async () => {
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
  itRepro("7-2", "C9 the first page answers 200 within 2s", async () => {
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
