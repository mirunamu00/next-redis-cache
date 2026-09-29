// Prewarm from the build output against real Redis (ROADMAP.md 7-4, A6): the entries equal what Next's
// FileSystemCache produces - segment keys = meta segmentPaths, "/" as "/index", route handlers, status and
// postponed state from the meta - and are written with SET NX. Uses the next-build fixture (Next 16.3.6).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redisVersionsUnderTest, startRedisContainer, type RedisServer } from "../support/redis-container";
import { connectTestClient, type TestRedisClient, type TrackedClient } from "../support/redis";
import { uniqueNamespace } from "../support/namespace";
import { legacyHandler, testConfig } from "../support/handlers";
import { prewarmFromBuildOutput } from "../../src/prewarm";
import { decodeEnvelope } from "../../src/envelope";
import { entryKey } from "../../src/keys";

const DIST = fileURLToPath(new URL("../fixtures/next-build/.next/", import.meta.url));

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

  const read = async (ns: string, key: string) => {
    const raw = (await client.withTypeMapping({ 36: Buffer }).get(entryKey(ns, "b1", key))) as unknown as Buffer | null;
    return raw ? await decodeEnvelope<{ lastModified: number; tags: string[]; revalidate: number | false }>(raw) : null;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const value = (e: { value: unknown } | null) => e?.value as any;

  const prewarm = async (ns: string, distDir = DIST) =>
    prewarmFromBuildOutput(testConfig({ client: client as never, namespace: ns, logger: false }), { distDir });

  describe("7-4 prewarm from build output", () => {
    it("[7-4] prewarms every prerendered route and reports the counts", async () => {
      const ns = uniqueNamespace();
      expect(await prewarm(ns)).toEqual({ prewarmed: 4, skipped: 0, failed: 0 });
      expect(await prewarm(ns)).toEqual({ prewarmed: 0, skipped: 4, failed: 0 }); // SET NX: never over an entry
    });

    it("[7-4] segment keys match the meta segmentPaths (/_tree, /about/__PAGE__)", async () => {
      const ns = uniqueNamespace();
      await prewarm(ns);
      expect([...value(await read(ns, "/about")).segmentData.keys()].sort()).toEqual(["/_full", "/_tree", "/about/__PAGE__"]);
    });

    it("[7-4] the root page is stored under Next's cache key /index", async () => {
      const ns = uniqueNamespace();
      await prewarm(ns);
      expect(value(await read(ns, "/index")).kind).toBe("APP_PAGE");
    });

    it("[7-4] APP_ROUTE outputs keep status and headers from their meta", async () => {
      const ns = uniqueNamespace();
      await prewarm(ns);
      const icon = value(await read(ns, "/icon"));
      expect(icon.kind).toBe("APP_ROUTE");
      expect(icon.status).toBe(200);
      expect(icon.headers["content-type"]).toBe("image/png");
      expect(Buffer.isBuffer(icon.body)).toBe(true);
    });

    it("[7-4] the not-found page is prewarmed and keeps status 404 from its meta", async () => {
      const ns = uniqueNamespace();
      await prewarm(ns);
      expect(value(await read(ns, "/_not-found")).status).toBe(404);
    });

    it("[7-4] entries carry the build tags, the file time and the manifest revalidate", async () => {
      const ns = uniqueNamespace();
      await prewarm(ns);
      const about = await read(ns, "/about");
      expect(about?.meta.tags).toContain("_N_T_/about");
      expect(about?.meta.revalidate).toBe(false);
      expect(about?.meta.lastModified).toBeGreaterThan(0);
      expect(await client.pTTL(entryKey(ns, "b1", "/about"))).toBeGreaterThan(29 * 24 * 3600 * 1000);
    });

    it("[7-4] a partially prerendered page keeps its postponed state from the meta", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "nrc-ppr-"));
      try {
        cpSync(DIST, root, { recursive: true });
        const metaPath = path.join(root, "server", "app", "about.meta");
        writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, "utf8")), postponed: "ppr-state" }));
        const ns = uniqueNamespace();
        await prewarm(ns, root);
        expect(value(await read(ns, "/about")).postponed).toBe("ppr-state");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("[7-4] a prewarmed entry is a hit for the legacy handler", async () => {
      const ns = uniqueNamespace();
      await prewarm(ns);
      const { handler } = legacyHandler({ client: client as never, namespace: ns });
      const got = await handler.get("/about", { kind: "APP_PAGE" });
      expect(got?.lastModified).toBeGreaterThan(0);
      expect(got?.value.segmentData.get("/_tree")).toBeInstanceOf(Buffer);
    });

    it("does nothing (and says so) when Redis is not usable", async () => {
      const result = await prewarmFromBuildOutput(testConfig({ client: null, logger: false }), { distDir: DIST });
      expect(result).toEqual({ prewarmed: 0, skipped: 0, failed: 0, unavailable: true });
    });
  });
});
