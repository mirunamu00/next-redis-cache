// Reproductions that need no network (ROADMAP.md 7-7, 7-8, 7-10, 7-11, 7-13). Each asserts the correct
// behavior and is an expected failure on 1.0.6 (tests/support/repro.ts).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, vi } from "vitest";
import { withTimeout } from "../../src/redis-client";
import { createUseCacheHandler } from "../../src/use-cache-handler";
import { freshLegacy, useCacheEntry } from "../support/handlers";
import { itRepro } from "../support/repro";

const repoFile = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

interface Call {
  cmd: string;
  args: unknown[];
}

/** Records commands; every command succeeds. Enough for code paths that only write. */
function recordingClient() {
  const calls: Call[] = [];
  const record =
    (cmd: string, result: unknown = null) =>
    (...args: unknown[]) => {
      calls.push({ cmd, args });
      return Promise.resolve(result);
    };
  const client = {
    isReady: true,
    isOpen: true,
    get: record("get"),
    set: record("set", "OK"),
    hSet: record("hSet", 1),
    hExists: record("hExists", 1),
    hmGet: (_k: string, fields: string[]) => {
      calls.push({ cmd: "hmGet", args: [_k, fields] });
      return Promise.resolve(fields.map(() => null));
    },
    unlink: record("unlink", 1),
  };
  return { client, calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("7-7 error reporting", () => {
  const consoleSpies = () => ({
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
  });

  itRepro("7-7", "use-cache: an outage is warned about once (not per request) and the recovery is reported", async () => {
    const { client } = recordingClient();
    const { warn, info } = consoleSpies();
    const handler = createUseCacheHandler({ client: client as never, keyPrefix: "t:" });
    client.isReady = false;
    for (let i = 0; i < 20; i++) expect(await handler.get(`k${i}`, [])).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    client.isReady = true;
    await handler.get("k", []);
    await handler.get("k", []);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/recovered/);
  });

  itRepro("7-7", "legacy: failing sets are warned about once until Redis recovers", async () => {
    const { client } = recordingClient();
    const { warn, info } = consoleSpies();
    const { handler } = await freshLegacy({ client: client as never, keyPrefix: "t:" });
    client.isReady = false;
    for (let i = 0; i < 20; i++) await handler.set(`/p${i}`, { kind: "FETCH", data: { headers: {}, body: "e30=", status: 200 }, revalidate: 60 }, { tags: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    client.isReady = true;
    await handler.set("/p", { kind: "FETCH", data: { headers: {}, body: "e30=", status: 200 }, revalidate: 60 }, { tags: [] });
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe("7-8 declared compatibility", () => {
  itRepro("7-8", "the next peer range does not admit Next 15 (not supported, Q2)", () => {
    const peer = JSON.parse(repoFile("package.json")).peerDependencies.next as string;
    const lowestMajor = Number(/(\d+)/.exec(peer)?.[1]);
    expect(lowestMajor).toBeGreaterThanOrEqual(16);
  });
});

describe("7-10 timeout timers", () => {
  itRepro("7-10", "withTimeout leaves no timer behind once the command settles", async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve("ok"), 5000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("7-11 TTL policy", () => {
  const ttlOf = (calls: Call[]) => {
    const set = calls.find((c) => c.cmd === "set");
    return (set?.args[2] as { EX?: number } | undefined)?.EX;
  };

  itRepro("7-11", "APP_ROUTE with cacheControl.revalidate=5 gets a TTL of about 7.5s", async () => {
    const { client, calls } = recordingClient();
    const { handler } = await freshLegacy({ client: client as never, keyPrefix: "t:" });
    await handler.set("/api/timed", { kind: "APP_ROUTE", body: Buffer.from("{}"), status: 200, headers: {} }, {
      cacheControl: { revalidate: 5, expire: undefined },
    });
    expect(ttlOf(calls)).toBeGreaterThan(0);
    expect(ttlOf(calls)).toBeLessThanOrEqual(8);
  });

  itRepro("7-11", "a static entry (revalidate false) is capped at 30 days, not 1.5 years", async () => {
    const { client, calls } = recordingClient();
    const { handler } = await freshLegacy({ client: client as never, keyPrefix: "t:" });
    await handler.set("/about", { kind: "APP_PAGE", html: "x", rscData: Buffer.from("r"), headers: {}, status: 200 }, {
      cacheControl: { revalidate: false, expire: undefined },
    });
    expect(ttlOf(calls)).toBeLessThanOrEqual(30 * 24 * 3600);
  });

  itRepro("7-11", "re-seeding an entry built long ago stores it (TTL counts from the write)", async () => {
    const { client, calls } = recordingClient();
    const { handler } = await freshLegacy({ client: client as never, keyPrefix: "t:", defaultStaleAge: 3600 });
    const twoDaysAgo = Date.now() - 2 * 24 * 3600 * 1000;
    await handler.set("/old", { kind: "APP_PAGE", html: "x", rscData: Buffer.from("r"), headers: {}, status: 200 }, {
      revalidate: false,
      internal_lastModified: twoDaysAgo,
    });
    expect(calls.some((c) => c.cmd === "set")).toBe(true);
  });
});

describe("7-13 README and defaults", () => {
  itRepro("7-13", "the default use-cache key prefix stays inside keyPrefix", async () => {
    const { client, calls } = recordingClient();
    const handler = createUseCacheHandler({ client: client as never, keyPrefix: "app:b1:" });
    await handler.set("k", Promise.resolve(useCacheEntry()));
    const key = calls.find((c) => c.cmd === "set")?.args[0] as string;
    expect(key.startsWith("app:b1:")).toBe(true);
  });

  itRepro("7-13", "README's cacheLife('hours') comment matches Next's built-in profile", () => {
    const readme = repoFile("README.md");
    const comment = /cacheLife\("hours"\);\s*\/\/\s*stale:\s*(\w+),\s*revalidate:\s*(\w+),\s*expire:\s*(\w+)/.exec(readme);
    expect(comment, "README still documents cacheLife('hours')").not.toBeNull();
    const seconds = (v: string) => Number(v.slice(0, -1)) * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[v.slice(-1)]!;
    const { defaultConfig } = createRequire(import.meta.url)("next/dist/server/config-shared.js");
    const hours = defaultConfig.cacheLife.hours as { stale: number; revalidate: number; expire: number };
    expect({ stale: seconds(comment![1]!), revalidate: seconds(comment![2]!), expire: seconds(comment![3]!) }).toEqual(hours);
  });

  itRepro("7-13", "README has a security section (Redis write access means cache poisoning)", () => {
    expect(repoFile("README.md")).toMatch(/^##+ Security/m);
  });

  itRepro("7-13", "README does not promise that every Redis call has a timeout", () => {
    // cleanupOldBuildKeys connects without a timeout (7-2/7-9), so the blanket claim is false
    expect(repoFile("README.md")).not.toMatch(/Every Redis (call|operation) is wrapped in a (configurable )?timeout/);
  });
});
