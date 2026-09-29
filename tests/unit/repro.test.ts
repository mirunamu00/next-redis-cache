// Regression tests that need no network (ROADMAP.md 7-7, 7-8, 7-10, 7-11, 7-13). Each asserts the correct
// behavior; they were expected failures on 1.0.6 (`itRepro`) and are plain tests since the fixing release.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "../../src/runner";
import { LegacyCore } from "../../src/legacy-handler";
import { resolveConfig } from "../../src/config";
import { fakeRedis, type FakeCall } from "../support/fake-redis";
import { legacyHandler, testConfig, useCacheEntry, useCacheHandler } from "../support/handlers";

const repoFile = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ttlOf = (calls: FakeCall[]) => {
  const set = calls.find((c) => c.cmd === "set");
  return (set?.args[2] as { expiration?: { value: number } } | undefined)?.expiration?.value;
};

describe("7-7 error reporting", () => {
  const consoleSpies = () => ({
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
  });

  it("[7-7] use-cache: an outage is warned about once (not per request) and the recovery is reported", async () => {
    const { fake, client } = fakeRedis();
    const { warn, info } = consoleSpies();
    const { handler } = useCacheHandler({ client });
    fake.isReady = false;
    for (let i = 0; i < 20; i++) expect(await handler.get(`k${i}`, [])).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    fake.isReady = true;
    await handler.get("k", []);
    await handler.get("k", []);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/recovered/);
  });

  it("[7-7] legacy: failing sets are warned about once until Redis recovers", async () => {
    const { fake, client } = fakeRedis();
    const { warn, info } = consoleSpies();
    const { handler } = legacyHandler({ client });
    fake.isReady = false;
    const data = { kind: "FETCH", data: { headers: {}, body: "e30=", status: 200 }, revalidate: 60 };
    for (let i = 0; i < 20; i++) await handler.set(`/p${i}`, data, { tags: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    fake.isReady = true;
    await handler.set("/p", data, { tags: [] });
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe("7-8 declared compatibility", () => {
  it("[7-8] the next peer range does not admit Next 15 (not supported, Q2)", () => {
    const peer = JSON.parse(repoFile("package.json")).peerDependencies.next as string;
    const lowestMajor = Number(/(\d+)/.exec(peer)?.[1]);
    expect(lowestMajor).toBeGreaterThanOrEqual(16);
  });
});

describe("7-10 timeout timers", () => {
  it("[7-10] withTimeout leaves no timer behind once the command settles", async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve("ok"), 5000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("7-11 TTL policy", () => {
  it("[7-11] APP_ROUTE with cacheControl.revalidate=5 gets a TTL of about 7.5s", async () => {
    const { fake, client } = fakeRedis();
    const { handler } = legacyHandler({ client });
    await handler.set("/api/timed", { kind: "APP_ROUTE", body: Buffer.from("{}"), status: 200, headers: {} }, {
      cacheControl: { revalidate: 5, expire: undefined },
    });
    expect(ttlOf(fake.calls)).toBeGreaterThan(0);
    expect(ttlOf(fake.calls)).toBeLessThanOrEqual(8);
  });

  it("[7-11] a static entry (revalidate false) is capped at 30 days, not 1.5 years", async () => {
    const { fake, client } = fakeRedis();
    const { handler } = legacyHandler({ client });
    await handler.set("/about", { kind: "APP_PAGE", html: "x", rscData: Buffer.from("r"), headers: {}, status: 200 }, {
      cacheControl: { revalidate: false, expire: undefined },
    });
    expect(ttlOf(fake.calls)).toBeLessThanOrEqual(30 * 24 * 3600);
  });

  it("[7-11] re-seeding an entry built long ago stores it (TTL counts from the write)", async () => {
    const { fake, client } = fakeRedis();
    const core = new LegacyCore(resolveConfig(testConfig({ client, ttl: { staticSeconds: 3600 } })));
    const twoDaysAgo = Date.now() - 2 * 24 * 3600 * 1000;
    const stored = await core.write(
      "/old",
      { lastModified: twoDaysAgo, tags: [], revalidate: false },
      { kind: "APP_PAGE", html: "x", rscData: Buffer.from("r"), headers: {}, status: 200 },
      { op: "reseed", onlyIfAbsent: true },
    );
    expect(stored).toBe(true);
    expect(ttlOf(fake.calls)).toBe(3600);
  });
});

describe("7-13 README and defaults", () => {
  it("[7-13] the default use-cache key stays inside the namespace", async () => {
    const { fake, client } = fakeRedis();
    const { handler } = useCacheHandler({ client, namespace: "app", buildId: "b1" });
    await handler.set("k", Promise.resolve(useCacheEntry()));
    const key = fake.calls.find((c) => c.cmd === "set")?.args[0] as string;
    expect(key.startsWith("app:b1:")).toBe(true);
  });

  it("[7-13] README's cacheLife('hours') comment matches Next's built-in profile", () => {
    const readme = repoFile("README.md");
    const comment = /cacheLife\("hours"\);\s*\/\/\s*stale:\s*(\w+),\s*revalidate:\s*(\w+),\s*expire:\s*(\w+)/.exec(readme);
    expect(comment, "README still documents cacheLife('hours')").not.toBeNull();
    const seconds = (v: string) => Number(v.slice(0, -1)) * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[v.slice(-1)]!;
    const { defaultConfig } = createRequire(import.meta.url)("next/dist/server/config-shared.js");
    const hours = defaultConfig.cacheLife.hours as { stale: number; revalidate: number; expire: number };
    expect({ stale: seconds(comment![1]!), revalidate: seconds(comment![2]!), expire: seconds(comment![3]!) }).toEqual(hours);
  });

  it("[7-13] README has a security section (Redis write access means cache poisoning)", () => {
    expect(repoFile("README.md")).toMatch(/^##+ Security/m);
  });

  it("[7-13] README does not promise that every Redis call has a timeout", () => {
    expect(repoFile("README.md")).not.toMatch(/Every Redis (call|operation) is wrapped in a (configurable )?timeout/);
  });
});
