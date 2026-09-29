// prewarmFromBuildOutput without Docker (ROADMAP.md 5.4, 7-4): reads every prerendered route through Next's
// FileSystemCache and writes it with SET NX; counts, TTLs from the manifest, PPR pages, unusable Redis.
// The Redis-backed version of these checks is tests/integration/prewarm.test.ts.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decodeEnvelope } from "../../src/envelope";
import { entryKey } from "../../src/keys";
import { prewarmFromBuildOutput } from "../../src/prewarm";
import { BUILD_TIME, buildCopy, type BuildCopy } from "../support/build-fixture";
import { fakeRedis, type FakeRedis } from "../support/fake-redis";
import { testConfig } from "../support/handlers";

let copy: BuildCopy;

beforeAll(() => {
  copy = buildCopy({ manifest: (m) => (m.routes["/icon"]!.initialRevalidateSeconds = 60) });
});

afterAll(() => {
  copy?.cleanup();
});

async function stored(fake: FakeRedis, key: string) {
  const v = fake.store.get(entryKey("pw", "b1", key));
  if (!v || v.kind !== "string") return undefined;
  return decodeEnvelope<{ lastModified: number; tags: string[]; revalidate: number | false }>(v.data);
}

describe("prewarmFromBuildOutput", () => {
  it("writes every prerendered route once with SET NX and reports the counts", async () => {
    const { fake, client } = fakeRedis();
    const config = testConfig({ client, namespace: "pw", logger: false });
    expect(await prewarmFromBuildOutput(config, { distDir: copy.distDir, concurrency: 2 })).toEqual({ prewarmed: 4, skipped: 0, failed: 0 });
    expect(await prewarmFromBuildOutput(config, { distDir: copy.distDir })).toEqual({ prewarmed: 0, skipped: 4, failed: 0 });
    const sets = fake.calls.filter((c) => c.cmd === "set");
    expect(sets).toHaveLength(8);
    for (const s of sets) expect((s.args[2] as { condition?: string }).condition).toBe("NX");
  });

  it("stores Next's entries: /index, segment paths, APP_ROUTE status and headers, 404 status, file time", async () => {
    const { fake, client } = fakeRedis();
    await prewarmFromBuildOutput(testConfig({ client, namespace: "pw", logger: false }), { distDir: copy.distDir });
    const about = await stored(fake, "/about");
    expect(about?.meta).toMatchObject({ lastModified: BUILD_TIME.getTime(), revalidate: false });
    expect(about?.meta.tags).toContain("_N_T_/about");
    expect([...(about?.value as { segmentData: Map<string, Buffer> }).segmentData.keys()].sort()).toEqual(["/_full", "/_tree", "/about/__PAGE__"]);
    expect((await stored(fake, "/index"))?.value).toMatchObject({ kind: "APP_PAGE" });
    expect((await stored(fake, "/_not-found"))?.value).toMatchObject({ status: 404 });
    const icon = await stored(fake, "/icon");
    expect(icon?.value).toMatchObject({ kind: "APP_ROUTE", status: 200, headers: { "content-type": "image/png" } });
    expect(icon?.meta.revalidate).toBe(60);
    // TTL: numeric revalidate -> estimateExpire (60 * 1.5), static -> 30 days
    const ttlOf = (key: string) => (fake.calls.find((c) => c.cmd === "set" && c.args[0] === entryKey("pw", "b1", key))?.args[2] as { expiration: { value: number } }).expiration.value;
    expect(ttlOf("/icon")).toBe(90);
    expect(ttlOf("/about")).toBe(30 * 24 * 3600);
  });

  it("keeps the postponed state of a partially prerendered page (no .rsc needed)", async () => {
    const ppr = buildCopy({
      files: (dist) => {
        const meta = path.join(dist, "server", "app", "about.meta");
        writeFileSync(meta, JSON.stringify({ ...JSON.parse(readFileSync(meta, "utf8")), postponed: "ppr-state" }));
      },
    });
    try {
      const { fake, client } = fakeRedis();
      await prewarmFromBuildOutput(testConfig({ client, namespace: "pw", logger: false }), { distDir: ppr.distDir });
      expect((await stored(fake, "/about"))?.value).toMatchObject({ postponed: "ppr-state" });
    } finally {
      ppr.cleanup();
    }
  });

  it("skips routes without App Router output (Pages Router) and counts unreadable pages as failed", async () => {
    const odd = buildCopy({
      manifest: (m) => {
        m.routes["/pages-router"] = { srcRoute: "/pages-router", initialRevalidateSeconds: false };
      },
      files: (dist) => rmSync(path.join(dist, "server", "app", "index.rsc")), // an html page without its RSC payload
    });
    try {
      const { client } = fakeRedis();
      const result = await prewarmFromBuildOutput(testConfig({ client, namespace: "pw", logger: false }), { distDir: odd.distDir });
      expect(result).toEqual({ prewarmed: 3, skipped: 1, failed: 1 });
    } finally {
      odd.cleanup();
    }
  });

  it("counts failed writes, and does nothing while Redis is not usable", async () => {
    const { fake, client } = fakeRedis();
    fake.failOn.set("set", new Error("OOM command not allowed"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await prewarmFromBuildOutput(testConfig({ client, namespace: "pw", logger: false }), { distDir: copy.distDir })).toEqual({ prewarmed: 0, skipped: 0, failed: 4 });
    const down = fakeRedis({ ready: false });
    expect(await prewarmFromBuildOutput(testConfig({ client: down.client, namespace: "pw", logger: false }), { distDir: copy.distDir })).toEqual({
      prewarmed: 0,
      skipped: 0,
      failed: 0,
      unavailable: true,
    });
    expect(down.fake.calls).toEqual([]);
    vi.restoreAllMocks();
  });
});
