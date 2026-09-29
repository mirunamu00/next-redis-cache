// Connection handling (ROADMAP.md 7-2, 7-3, 7-7, 7-9, A3, A4) with mini-redis and closed ports - no Docker.
// Every test asserts the correct behavior; the 7-x tests were expected failures on 1.0.6.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@redis/client";
import { startMiniRedis, type MiniRedis } from "../support/mini-redis";
import { deadPort } from "../support/net";
import { legacyHandler, useCacheEntry, useCacheHandler } from "../support/handlers";
import { captureUnhandledRejections, within } from "../support/repro";
import { waitFor } from "../support/wait-for";
import { uniqueNamespace } from "../support/namespace";
import { closeSharedClients, connectRedis } from "../../src/redis";
import { cleanupOldBuildKeys } from "../../src/legacy-cleanup";

// Clients created by the package itself (connectRedis, cleanupOldBuildKeys) are captured so a test can
// destroy them; otherwise a reconnecting client would outlive the test file.
const created = vi.hoisted(() => [] as Array<{ destroy(): void; isOpen: boolean }>);
vi.mock("@redis/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@redis/client")>();
  return {
    ...mod,
    createClient: ((...args: Parameters<typeof mod.createClient>) => {
      const c = mod.createClient(...args);
      created.push(c as unknown as { destroy(): void; isOpen: boolean });
      return c;
    }) as typeof mod.createClient,
  };
});

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await closeSharedClients();
  for (const c of created.splice(0)) {
    try {
      if (c.isOpen) c.destroy();
    } catch {
      // already closed
    }
  }
  vi.restoreAllMocks();
});

function client(url: string, reconnect: false | number | "default" = "default") {
  const c = createClient({
    url,
    socket: reconnect === "default" ? {} : { reconnectStrategy: reconnect === false ? false : () => reconnect },
  });
  c.on("error", () => {});
  cleanups.push(() => {
    if (c.isOpen) c.destroy();
  });
  return c;
}

async function mini(): Promise<MiniRedis> {
  const m = await startMiniRedis();
  cleanups.push(() => m.stop());
  return m;
}

const quiet = () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
};

describe("7-2 an unreachable Redis never blocks a request", () => {
  it("[7-2] legacy get() settles as a miss within 1.5s with the README wiring (connectRedis)", async () => {
    quiet();
    const url = `redis://127.0.0.1:${await deadPort()}`;
    const { handler } = legacyHandler({ client: () => connectRedis(url) });
    expect(await within(handler.get("/page", { kind: "APP_PAGE" }), 1500)).toEqual({ settled: true, value: null });
    // later calls do not wait for the connection again
    expect(await within(handler.get("/page", { kind: "APP_PAGE" }), 50)).toEqual({ settled: true, value: null });
  });

  it("[7-2] a client function that throws degrades to a miss instead of rejecting", async () => {
    quiet();
    const { handler } = legacyHandler({
      client: () => {
        throw new Error("connect failed");
      },
    });
    await expect(handler.get("/page", {})).resolves.toBeNull();
    const uc = useCacheHandler({
      client: async () => {
        throw new Error("connect failed");
      },
    }).handler;
    await expect(uc.get("k", [])).resolves.toBeUndefined();
  });

  it("[7-2] a client that was never connected is a fast miss (nothing is queued)", async () => {
    quiet();
    const c = client(`redis://127.0.0.1:${await deadPort()}`);
    const { handler } = legacyHandler({ client: c as never });
    expect(await within(handler.get("/page", {}), 100)).toEqual({ settled: true, value: null });
  });

  it("[7-2] the deprecated cleanupOldBuildKeys gives up within 3s when Redis is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await within(cleanupOldBuildKeys({ redisUrl: `redis://127.0.0.1:${await deadPort()}`, patterns: [{ scan: "x:*" }] }), 3000);
    expect(result).toEqual({ settled: true, value: { deleted: 0 } });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("[cache-cleanup] Gave up"))).toBe(true);
    expect(created.every((c) => !c.isOpen), "the cleanup client is closed").toBe(true);
  });
});

describe("connectRedis", () => {
  it("returns null without a URL", async () => {
    expect(await connectRedis(undefined)).toBeNull();
    expect(await connectRedis("")).toBeNull();
  });

  it("returns within waitMs when Redis is down, and keeps connecting in the background", async () => {
    const lines: string[] = [];
    const port = await deadPort();
    const t0 = Date.now();
    const c = await connectRedis(`redis://127.0.0.1:${port}`, { waitMs: 300, logger: { warn: (m) => lines.push(String(m)), info: (m) => lines.push(String(m)) } });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(c?.isReady).toBe(false);
    const m = await startMiniRedis({ port });
    cleanups.push(() => m.stop());
    await waitFor(() => c?.isReady, { timeout: 15_000, message: "background reconnect" });
    expect(await c!.ping()).toBe("PONG");
    // one warning for the outage (not one per reconnect attempt), one line for the recovery
    expect(lines.filter((l) => l.includes("unavailable") || l.includes("not connected"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("connected to") && l.includes("again"))).toBe(true);
    expect(lines.join("\n")).not.toContain(":test@");
  });

  it("shares one client per URL across callers", async () => {
    const m = await mini();
    const [a, b] = await Promise.all([connectRedis(m.url), connectRedis(m.url)]);
    expect(a).toBe(b);
    expect(a?.isReady).toBe(true);
    const own = await connectRedis(m.url, { shared: false });
    expect(own).not.toBe(a);
    own?.destroy();
  });
});

describe("7-3 readiness is checked before a command is sent", () => {
  it("[7-3] use-cache get on a closed client causes no unhandled rejections", async () => {
    quiet();
    const m = await mini();
    const c = client(m.url, false);
    await c.connect();
    const { handler } = useCacheHandler({ client: c as never });
    await m.stop();
    await waitFor(() => !c.isOpen, { message: "client closed after the server went away" });

    const rejections = await captureUnhandledRejections(async () => {
      for (let i = 0; i < 100; i++) expect(await handler.get(`k${i}`, [])).toBeUndefined();
    });
    expect(rejections).toHaveLength(0);
  });

  it("[7-3] gets during a reconnect are not queued and replayed after recovery (A4)", async () => {
    quiet();
    const m = await mini();
    const c = client(m.url, 50);
    await c.connect();
    const ns = uniqueNamespace();
    const uc = useCacheHandler({ client: c as never, namespace: ns }).handler;
    const legacy = legacyHandler({ client: c as never, namespace: ns }).handler;
    await m.stop();
    await waitFor(() => !c.isReady, { message: "client not ready after the outage" });

    for (let i = 0; i < 50; i++) {
      expect(await uc.get(`k${i}`, ["t"])).toBeUndefined();
      expect(await legacy.get(`/p${i}`, { kind: "FETCH", tags: ["t"] })).toBeNull();
      await legacy.set(`/p${i}`, { kind: "FETCH", data: { headers: {}, body: "", status: 200 }, revalidate: 60 }, { fetchCache: true });
      await uc.updateTags(["t"]);
    }
    const before = m.calls.length;
    await m.start();
    await waitFor(() => c.isReady, { timeout: 5000, message: "client reconnected" });
    await new Promise((r) => setTimeout(r, 200));
    const replayed = m.calls.slice(before).filter(([, key]) => key?.startsWith(`${ns}:`));
    expect(replayed).toHaveLength(0);
  });
});

describe("A3 an unresponsive Redis (hang)", () => {
  it("[A3] the first call waits at most readMs, then the circuit answers at once", async () => {
    quiet();
    const m = await mini();
    const c = client(m.url, 50);
    await c.connect();
    const { handler } = legacyHandler({ client: c as never, timeouts: { readMs: 300 }, circuitBreaker: { openMs: 2000 } });
    m.hang(true);
    cleanups.push(() => m.hang(false));
    const t0 = performance.now();
    expect(await handler.get("/p", {})).toBeNull();
    const first = performance.now() - t0;
    expect(first).toBeGreaterThanOrEqual(250);
    expect(first).toBeLessThan(800);
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      expect(await handler.get(`/p${i}`, {})).toBeNull();
      expect(performance.now() - t).toBeLessThan(50);
    }
  });

  it("[A3] after openMs the handler tries Redis again and recovers", async () => {
    quiet();
    const m = await mini();
    const c = client(m.url, 50);
    await c.connect();
    const { handler } = useCacheHandler({ client: c as never, timeouts: { readMs: 200 }, circuitBreaker: { openMs: 300 } });
    await handler.set("k", Promise.resolve(useCacheEntry({ value: "v" })));
    m.hang(true);
    expect(await handler.get("k", [])).toBeUndefined();
    m.hang(false); // drops connections; the client reconnects
    await waitFor(() => c.isReady, { timeout: 5000, message: "client reconnected" });
    await new Promise((r) => setTimeout(r, 350));
    expect(await handler.get("k", [])).toBeDefined();
  });
});

describe("7-7 errors are reported without debug mode", () => {
  it("[7-7] a set that times out while Redis hangs is reported through console.warn", async () => {
    const m = await mini();
    const c = client(m.url, 50);
    await c.connect();
    const { handler } = legacyHandler({ client: c as never, timeouts: { writeMs: 200 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.hang(true);
    cleanups.push(() => m.hang(false));
    await handler.set("/page", { kind: "FETCH", data: { headers: {}, body: "e30=", status: 200 }, revalidate: 60 }, { fetchCache: true, tags: [] });
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("mini-redis round trip (baseline)", () => {
  it("stores and reads back both kinds of entries, binary-safe", async () => {
    const m = await mini();
    const c = client(m.url, 50);
    await c.connect();
    const uc = useCacheHandler({ client: c as never }).handler;
    await uc.set("k", Promise.resolve(useCacheEntry({ value: "hello" })));
    const entry = await uc.get("k", []);
    expect(entry && (await new Response(entry.value).text())).toBe("hello");
    const { handler } = legacyHandler({ client: c as never });
    const body = Buffer.from([0, 255, 13, 10, 0]);
    await handler.set("/bin", { kind: "APP_ROUTE", body, status: 200, headers: {} }, {});
    expect((await handler.get("/bin", { kind: "APP_ROUTE" }))?.value.body.equals(body)).toBe(true);
  });
});
