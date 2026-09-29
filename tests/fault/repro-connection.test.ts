// Reproductions of the connection-handling bugs (ROADMAP.md 7-2, 7-3, 7-7, 7-9) with mini-redis and
// closed ports - no Docker. Every test asserts the correct behavior and is an expected failure on
// 1.0.6 (see tests/support/repro.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@redis/client";
import { startMiniRedis, type MiniRedis } from "../support/mini-redis";
import { deadPort } from "../support/net";
import { freshInstrumentation, freshLegacy, useCacheEntry } from "../support/handlers";
import { captureUnhandledRejections, itRepro, within } from "../support/repro";
import { waitFor } from "../support/wait-for";
import { uniqueNamespace } from "../support/namespace";
import { createUseCacheHandler } from "../../src/use-cache-handler";

// Clients created by the package itself (cleanupOldBuildKeys) are captured so a test can destroy
// them; otherwise a client stuck in 1.0.6's endless reconnect loop would outlive the test file.
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

describe("7-2 connection wiring from the README", () => {
  itRepro("7-2", "legacy get() settles as a miss within 1.5s when Redis is unreachable", async () => {
    const c = client(`redis://127.0.0.1:${await deadPort()}`);
    const { handler } = await freshLegacy(async () => {
      await c.connect(); // README Quick Start, Step 1
      return { client: c as never, keyPrefix: `${uniqueNamespace()}:` };
    });
    expect(await within(handler.get("/page", {}), 1500)).toEqual({ settled: true, value: null });
  });

  itRepro("7-2", "an onCreation hook that throws degrades to a miss instead of rejecting", async () => {
    const { handler } = await freshLegacy(async () => {
      throw new Error("connect failed");
    });
    await expect(handler.get("/page", {})).resolves.toBeNull();
  });

  itRepro("7-2", "cleanupOldBuildKeys gives up within 3s when Redis is unreachable", async () => {
    const { cleanupOldBuildKeys } = await freshInstrumentation();
    const result = await within(
      cleanupOldBuildKeys({ redisUrl: `redis://127.0.0.1:${await deadPort()}`, patterns: [{ scan: "x:*" }] }),
      3000,
    );
    expect(result.settled).toBe(true);
  });
});

describe("7-3 commands are sent before the readiness check", () => {
  itRepro("7-3", "use-cache get on a closed client causes no unhandled rejections", async () => {
    const m = await mini();
    const c = client(m.url, false);
    await c.connect();
    const handler = createUseCacheHandler({ client: c as never, keyPrefix: `${uniqueNamespace()}:` });
    await m.stop();
    await waitFor(() => !c.isOpen, { message: "client closed after the server went away" });

    const rejections = await captureUnhandledRejections(async () => {
      for (let i = 0; i < 100; i++) expect(await handler.get(`k${i}`, [])).toBeUndefined();
    });
    expect(rejections).toHaveLength(0);
  });

  itRepro("7-3", "use-cache gets during a reconnect are not queued and replayed after recovery", async () => {
    const m = await mini();
    const c = client(m.url, 50);
    await c.connect();
    const ns = `${uniqueNamespace()}:`;
    const handler = createUseCacheHandler({ client: c as never, keyPrefix: ns });
    await m.stop();
    await waitFor(() => !c.isReady, { message: "client not ready after the outage" });

    for (let i = 0; i < 100; i++) expect(await handler.get(`k${i}`, [])).toBeUndefined();
    const before = m.calls.length;
    await m.start();
    await waitFor(() => c.isReady, { timeout: 5000, message: "client reconnected" });
    await new Promise((r) => setTimeout(r, 200));
    // 1.x puts use-cache keys under "uc:" + keyPrefix (7-13), so match the namespace anywhere in the key
    const replayed = m.calls.slice(before).filter(([cmd, key]) => cmd === "GET" && key?.includes(ns));
    expect(replayed).toHaveLength(0);
  });

  it("[7-3] legacy handler checks readiness before sending (not affected)", async () => {
    const m = await mini();
    const c = client(m.url, 50);
    await c.connect();
    const ns = `${uniqueNamespace()}:`;
    const { handler } = await freshLegacy({ client: c as never, keyPrefix: ns });
    await m.stop();
    await waitFor(() => !c.isReady, { message: "client not ready after the outage" });
    for (let i = 0; i < 20; i++) expect(await handler.get(`/p${i}`, {})).toBeNull();
    const before = m.calls.length;
    await m.start();
    await waitFor(() => c.isReady, { timeout: 5000, message: "client reconnected" });
    await new Promise((r) => setTimeout(r, 200));
    expect(m.calls.slice(before).filter(([cmd, key]) => cmd === "GET" && key?.startsWith(ns))).toHaveLength(0);
  });
});

describe("7-7 errors are only logged in debug mode", () => {
  itRepro("7-7", "a set that times out while Redis hangs is reported through console.warn/error", async () => {
    const m = await mini();
    const c = client(m.url, 50);
    await c.connect();
    const { handler } = await freshLegacy({ client: c as never, keyPrefix: `${uniqueNamespace()}:`, timeoutMs: 200 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    m.hang(true);
    cleanups.push(() => m.hang(false));
    await handler.set("/page", { kind: "FETCH", data: { headers: {}, body: "e30=", status: 200 }, revalidate: 60 }, { tags: [] });
    expect(warn.mock.calls.length + error.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("use-cache set with a pending entry (baseline)", () => {
  it("stores and reads back an entry through mini-redis", async () => {
    const m = await mini();
    const c = client(m.url, 50);
    await c.connect();
    const handler = createUseCacheHandler({ client: c as never, keyPrefix: `${uniqueNamespace()}:` });
    await handler.set("k", Promise.resolve(useCacheEntry({ value: "hello" })));
    const entry = await handler.get("k", []);
    expect(entry && (await new Response(entry.value).text())).toBe("hello");
  });
});
