// Build-output fallback and re-seeding (ROADMAP.md 5.4, A2): prerendered pages and route handlers answer
// from `.next/server/app` (read by Next's own FileSystemCache) when Redis has nothing or is unavailable.
// Uses the next-build fixture (a Next 16.3.6 static-site build) and an in-memory client.
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheEvent, RedisCacheConfig } from "../../src/types";
import { entryKey } from "../../src/keys";
import { decodeEnvelope } from "../../src/envelope";
import { fakeRedis } from "../support/fake-redis";
import { legacyHandler } from "../support/handlers";
import { waitFor } from "../support/wait-for";

const SERVER_DIST = fileURLToPath(new URL("../fixtures/next-build/.next/server/", import.meta.url));
const ABOUT_MTIME = statSync(path.join(SERVER_DIST, "app", "about.html")).mtime.getTime();
const PAGE = { kind: "APP_PAGE" } as const;
const ROUTE = { kind: "APP_ROUTE" } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(extra: Partial<RedisCacheConfig> = {}, ready = true, dev = false) {
  const { fake, client } = fakeRedis({ ready });
  const events: CacheEvent[] = [];
  const { handler, config, Handler } = legacyHandler({ client, fallback: {}, onEvent: (e) => events.push(e), ...extra }, dev ? undefined : SERVER_DIST);
  const devHandler = dev ? new Handler({ serverDistDir: SERVER_DIST, dev: true }) : undefined;
  return { fake, handler: devHandler ?? handler, events, ns: config.namespace };
}

describe("serving from the build output", () => {
  it("[A2] a prerendered page absent from Redis is served from disk with the file time", async () => {
    const { handler, events } = setup();
    const got = await handler.get("/about", PAGE);
    expect(got?.value.kind).toBe("APP_PAGE");
    expect(got?.value.html).toContain("<html");
    expect(got?.lastModified).toBe(ABOUT_MTIME);
    expect([...got!.value.segmentData.keys()].sort()).toEqual(["/_full", "/_tree", "/about/__PAGE__"]);
    expect(events).toContainEqual({ type: "fallback", handler: "legacy", key: "/about", state: "fresh" });
  });

  it("[A2] route handlers (APP_ROUTE) and the root page (/index) are served too", async () => {
    const { handler } = setup();
    const icon = await handler.get("/icon", ROUTE);
    expect(Buffer.isBuffer(icon?.value.body)).toBe(true);
    expect(icon?.value.headers["content-type"]).toBe("image/png");
    expect((await handler.get("/index", PAGE))?.value.kind).toBe("APP_PAGE");
  });

  it("[A2] without any Redis client the build output still answers", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { handler } = setup({ client: null });
    expect((await handler.get("/about", PAGE))?.lastModified).toBe(ABOUT_MTIME);
  });

  it("while Redis is not ready the page is served as it is and nothing is sent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, handler, events } = setup({}, false);
    expect((await handler.get("/about", PAGE))?.lastModified).toBe(ABOUT_MTIME);
    expect(fake.calls).toEqual([]);
    expect(events).toContainEqual({ type: "fallback", handler: "legacy", key: "/about", state: "unknown" });
  });

  it("is not used for fetch entries, unknown keys, in dev, while disabled or with fallback: false", async () => {
    expect(await setup().handler.get("/about", { kind: "FETCH" })).toBeNull();
    expect(await setup().handler.get("/nope", PAGE)).toBeNull();
    expect(await setup({}, true, true).handler.get("/about", PAGE)).toBeNull();
    expect(await setup({ disabled: true }).handler.get("/about", PAGE)).toBeNull();
    expect(await setup({ fallback: false }).handler.get("/about", PAGE)).toBeNull();
    expect(await setup({ fallback: { buildOutput: false } }).handler.get("/about", PAGE)).toBeNull();
  });
});

/** A copy of the fixture where /about is a prerendered path of a dynamicParams = false route. */
function fallbackFalseCopy() {
  const root = mkdtempSync(path.join(tmpdir(), "nrc-ff-"));
  cpSync(path.join(SERVER_DIST, ".."), root, { recursive: true });
  const file = path.join(root, "prerender-manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.routes["/about"].srcRoute = "/[page]";
  manifest.dynamicRoutes = { "/[page]": { fallback: false } };
  writeFileSync(file, JSON.stringify(manifest));
  return { serverDistDir: path.join(root, "server"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("tag state of build-output entries", () => {
  it("a page invalidated after the build is a miss, so Next renders it before answering (onTagExpired auto)", async () => {
    const { handler, events } = setup();
    await handler.revalidateTag("_N_T_/about");
    expect(await handler.get("/about", PAGE)).toBeNull();
    expect(events.at(-1)).toMatchObject({ type: "miss", reason: "tag" });
  });

  it("a prerendered path of a dynamicParams=false route is served stale instead (a miss would be a 404)", async () => {
    const copy = fallbackFalseCopy();
    try {
      const { client } = fakeRedis();
      const { handler } = legacyHandler({ client, fallback: {} }, copy.serverDistDir);
      await handler.revalidateTag("_N_T_/about");
      const got = await handler.get("/about", PAGE);
      expect(got?.lastModified).toBe(-1);
      expect(got?.value.html).toContain("<html");
    } finally {
      copy.cleanup();
    }
  });

  it("onTagExpired: \"stale\" serves the invalidated page with lastModified -1", async () => {
    const { handler, events } = setup({ onTagExpired: "stale" });
    await handler.revalidateTag("_N_T_/about");
    expect((await handler.get("/about", PAGE))?.lastModified).toBe(-1);
    expect(events).toContainEqual({ type: "fallback", handler: "legacy", key: "/about", state: "stale" });
  });

  it("revalidateTag(tag, { expire }) also serves it stale", async () => {
    const { handler } = setup();
    await handler.revalidateTag("_N_T_/about", { expire: 3600 });
    expect((await handler.get("/about", PAGE))?.lastModified).toBe(-1);
  });

  it("onTagExpired: \"miss\" returns null for an expired build-output page", async () => {
    const { handler } = setup({ onTagExpired: "miss" });
    await handler.revalidateTag("_N_T_/about");
    expect(await handler.get("/about", PAGE)).toBeNull();
  });
});

describe("re-seeding", () => {
  it("writes a fresh build-output entry back to Redis once (SET NX, TTL of a static page)", async () => {
    const { fake, handler, ns, events } = setup();
    await Promise.all([handler.get("/about", PAGE), handler.get("/about", PAGE), handler.get("/about", PAGE)]);
    await waitFor(() => events.some((e) => e.type === "reseed"), { message: "reseed event" });
    const sets = fake.calls.filter((c) => c.cmd === "set");
    expect(sets).toHaveLength(1);
    expect(sets[0]!.args[0]).toBe(entryKey(ns, "b1", "/about"));
    expect(sets[0]!.args[2]).toEqual({ expiration: { type: "EX", value: 30 * 24 * 3600 }, condition: "NX" });
    const { meta } = await decodeEnvelope<{ lastModified: number; tags: string[] }>(fake.store.get(entryKey(ns, "b1", "/about"))!.data as Buffer);
    expect(meta.lastModified).toBe(ABOUT_MTIME);
    expect(meta.tags).toContain("_N_T_/about");
    // the next request is a Redis hit
    expect((await handler.get("/about", PAGE))?.lastModified).toBe(ABOUT_MTIME);
    expect(events.at(-1)).toMatchObject({ type: "hit", key: "/about" });
  });

  it("does not re-seed a stale entry, with reseed: false, or while Redis is unavailable", async () => {
    const stale = setup();
    await stale.handler.revalidateTag("_N_T_/about");
    await stale.handler.get("/about", PAGE);
    const off = setup({ fallback: { reseed: false } });
    await off.handler.get("/about", PAGE);
    await new Promise((r) => setTimeout(r, 20));
    expect(stale.fake.count("set")).toBe(0);
    expect(off.fake.count("set")).toBe(0);
  });
});
