// Old-build cleanup and background maintenance with mini-redis (ROADMAP.md 5.5, 7-9) - ported from the docs
// app's build-keys tests: keep current + previous, delete other builds only when idle (OBJECT IDLETIME),
// cap TTLs, rollbacks, reserved owners, 1.x layouts, waiting for Redis with backoff.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@redis/client";
import { startMiniRedis, type MiniRedis } from "../support/mini-redis";
import { deadPort } from "../support/net";
import { waitFor } from "../support/wait-for";
import {
  cleanupOldBuilds,
  DEFAULT_MIN_IDLE_SECONDS,
  DEFAULT_RETIRED_TTL_SECONDS,
  startCacheMaintenance,
  whenReady,
} from "../../src/maintenance";
import { closeSharedClients, connectRedis } from "../../src/redis";

let mini: MiniRedis;
let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  mini = await startMiniRedis();
  client = createClient({ url: mini.url });
  client.on("error", () => {});
  await client.connect();
});

afterAll(async () => {
  client?.destroy();
  await mini?.stop();
});

beforeEach(() => mini.flush());

afterEach(async () => {
  await closeSharedClients();
  vi.restoreAllMocks();
});

const WEEK = 7 * 24 * 3600;
const HOUR = 3600;

/** One build: n entry keys with a week of TTL (2.x layout). */
const seed = (build: string, n = 3) => {
  for (let i = 0; i < n; i++) mini.setString(`docs:${build}:e:/docs/p${i}`, "x", WEEK);
};
const buildsLeft = () => [...new Set(mini.keys().filter((k) => !k.startsWith("docs:_")).map((k) => k.split(":")[1]))].sort();
const clean = (buildId: string, now: number, extra = {}) => cleanupOldBuilds(client as never, { namespace: "docs", buildId, now, batchSize: 2, ...extra });

describe("cleanupOldBuilds", () => {
  it("[7-9] keeps the current and the previous build, deletes idle older builds (batched UNLINK)", async () => {
    seed("A");
    await clean("A", 1000);
    seed("B");
    await clean("B", 2000);
    seed("C", 5);
    mini.age(HOUR);
    const r = await clean("C", 3000);
    expect(buildsLeft()).toEqual(["B", "C"]);
    expect(r).toMatchObject({ deleted: 3, removedBuilds: ["A"], deferredBuilds: [] });
    expect(r.kept.sort()).toEqual(["B", "C"]);
    expect(await client.zRange("docs:_builds", 0, -1)).toEqual(["B", "C"]);
    expect(mini.calls.filter(([c]) => c === "UNLINK").length).toBeGreaterThanOrEqual(2);
  });

  it("[7-9] keeps an old build that is still being read (rolling update): deferred with a TTL cap", async () => {
    seed("A");
    await clean("A", 1000);
    seed("B");
    await clean("B", 2000);
    seed("C");
    mini.age(HOUR);
    mini.touch("docs:A:e:/docs/p1"); // an old instance just read one of its keys
    const r = await clean("C", 3000);
    expect(buildsLeft()).toEqual(["A", "B", "C"]);
    expect(r.deferredBuilds).toEqual(["A"]);
    expect(mini.ttl("docs:A:e:/docs/p0")).toBeLessThanOrEqual(DEFAULT_RETIRED_TTL_SECONDS);
    expect(await client.zRange("docs:_builds", 0, -1)).toContain("A");
    // once nobody reads it any more, the next start removes it (EXPIRE did not refresh its age)
    mini.age(DEFAULT_MIN_IDLE_SECONDS + 60);
    await clean("C", 3500);
    expect(buildsLeft()).toEqual(["B", "C"]);
  });

  it("a restart of the same build (replica, restart) keeps its keys and the previous build", async () => {
    seed("A");
    await clean("A", 1000);
    seed("B");
    await clean("B", 2000);
    mini.age(HOUR);
    await clean("B", 3000);
    expect(buildsLeft()).toEqual(["A", "B"]);
  });

  it("orphans (unregistered builds, 1.x layouts) are deleted when idle, deferred when recent", async () => {
    for (let i = 0; i < 3; i++) mini.setString(`docs:sha1:/docs/p${i}`, "{}", WEEK); // 1.x: {ns}:{build}:{key}
    mini.setHash("docs:sha1:_tags", { "/docs/p0": "[]" }); // 1.x tag hash of that build
    mini.setString("docs:sha2:/docs/p0", "{}", WEEK);
    mini.age(HOUR);
    mini.touch("docs:sha2:/docs/p0");
    const r = await clean("NEW", 1000);
    expect(r.removedBuilds).toEqual(["sha1"]);
    expect(r.deferredBuilds).toEqual(["sha2"]);
    expect(buildsLeft()).toEqual(["sha2"]);
  });

  it("never touches reserved owners (_tagstate, _builds) but removes idle 1.x tag hashes without a build", async () => {
    mini.setHash("docs:_tagstate", { "x:t": "1" });
    mini.setHash("docs:_tags", { "/p": "[]" });
    mini.setHash("docs:__revalidated_tags__", { t: "1" });
    seed("A");
    mini.age(HOUR);
    await clean("B", 1000);
    expect(mini.keys().sort()).toEqual(["docs:_builds", "docs:_tagstate"]);
    expect(mini.ttl("docs:_tagstate")).toBe(-1);
  });

  it("an idle time that cannot be read (LFU policy) means in use: nothing is deleted", async () => {
    seed("old");
    mini.age(HOUR);
    const noIdle = new Proxy(client, {
      get(target, prop) {
        if (prop === "objectIdleTime") return () => Promise.reject(new Error("ERR An LFU maxmemory policy is selected, idle time not tracked"));
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const r = await cleanupOldBuilds(noIdle as never, { namespace: "docs", buildId: "B", now: 1000 });
    expect(r.deferredBuilds).toEqual(["old"]);
    expect(buildsLeft()).toEqual(["old"]);
  });

  it("TTL: the current build is untouched, previous builds are capped, shorter TTLs stay", async () => {
    seed("A");
    mini.setString("docs:A:e:/short", "x", 60);
    mini.setHash("docs:A:e:/nottl", { f: "1" });
    await clean("A", 1000);
    seed("B");
    const r = await clean("B", 2000);
    expect(mini.ttl("docs:B:e:/docs/p0")).toBeGreaterThan(DEFAULT_RETIRED_TTL_SECONDS);
    expect(mini.ttl("docs:A:e:/docs/p0")).toBeLessThanOrEqual(DEFAULT_RETIRED_TTL_SECONDS);
    expect(mini.ttl("docs:A:e:/nottl")).toBeLessThanOrEqual(DEFAULT_RETIRED_TTL_SECONDS);
    expect(mini.ttl("docs:A:e:/short")).toBeLessThanOrEqual(60);
    expect(r.ttlCapped).toBe(4);
  });

  it("rollback: the re-deployed old build becomes current, the build just before it stays as previous", async () => {
    seed("A");
    await clean("A", 1000);
    seed("B");
    await clean("B", 2000);
    seed("C");
    await clean("C", 3000);
    mini.age(HOUR);
    await clean("B", 4000); // roll back to B
    expect(buildsLeft()).toEqual(["B", "C"]);
    expect((await client.zRange("docs:_builds", 0, -1)).slice(-1)).toEqual(["B"]);
  });

  it("does not match other namespaces sharing a prefix, and escapes glob characters", async () => {
    mini.setString("docs-canary:A:e:/p", "x", WEEK);
    mini.setString("docsX:A:e:/p", "x", WEEK);
    mini.age(HOUR);
    await clean("B", 1000);
    expect(mini.keys()).toContain("docs-canary:A:e:/p");
    expect(mini.keys()).toContain("docsX:A:e:/p");
  });
});

describe("whenReady", () => {
  it("runs once Redis becomes ready (ready event), instead of skipping the run", async () => {
    const port = await deadPort();
    const late = await startMiniRedis({ port });
    for (let i = 0; i < 3; i++) late.setString(`docs:legacy:e:/p${i}`, "x", WEEK);
    late.age(HOUR);
    await late.stop();
    const c = await connectRedis(`redis://127.0.0.1:${port}`, { waitMs: 100, logger: false, shared: false });
    try {
      expect(c!.isReady).toBe(false);
      const pending = whenReady(c!, () => cleanupOldBuilds(c!, { namespace: "docs", buildId: "NEW", now: 1000 }), { baseDelayMs: 60_000 });
      await new Promise((r) => setTimeout(r, 200));
      await late.start();
      const result = await pending;
      expect(result.gaveUp).toBe(false);
      if (!result.gaveUp) expect(result.value.removedBuilds).toEqual(["legacy"]);
      expect(result.attempts).toBeGreaterThanOrEqual(2);
      expect(late.keys()).toEqual(["docs:_builds"]);
    } finally {
      c?.destroy();
      await late.stop();
    }
  });

  it("gives up after `attempts` with exponential backoff (cause: disconnected)", async () => {
    const c = await connectRedis(`redis://127.0.0.1:${await deadPort()}`, { waitMs: 50, logger: false, shared: false });
    try {
      const t0 = Date.now();
      const result = await whenReady(c!, () => Promise.resolve(1), { attempts: 4, baseDelayMs: 20, maxDelayMs: 50 });
      expect(result).toEqual({ gaveUp: true, attempts: 4, cause: "disconnected", error: undefined });
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      c?.destroy();
    }
  });

  it("a command error is retried and reported as an error (not a connection problem)", async () => {
    let calls = 0;
    const result = await whenReady(
      client as never,
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("WRONGTYPE Operation against a key\nholding the wrong kind of value");
        return "ok";
      },
      { attempts: 5, baseDelayMs: 5 },
    );
    expect(result).toEqual({ gaveUp: false, attempts: 3, value: "ok" });
    const failing = await whenReady(client as never, () => Promise.reject(new Error("WRONGTYPE")), { attempts: 2, baseDelayMs: 5 });
    expect(failing).toMatchObject({ gaveUp: true, cause: "error" });
  });
});

describe("startCacheMaintenance", () => {
  const config = (extra = {}) => ({ client: () => connectRedis(mini.url, { logger: false }), namespace: "docs", buildId: "C", disabled: false, ...extra });

  it("cleans up in the background and logs one line", async () => {
    const lines: string[] = [];
    seed("A");
    await clean("A", 1000);
    seed("B");
    await clean("B", 2000);
    mini.age(HOUR);
    const { done } = startCacheMaintenance({ config: config({ logger: { info: (m: unknown) => lines.push(String(m)), warn: (m: unknown) => lines.push(String(m)) } }) });
    const result = await done;
    expect(result.cleanup).toMatchObject({ gaveUp: false, value: { removedBuilds: ["A"] } });
    expect(buildsLeft()).toEqual(["B"]);
    expect(await client.zRange("docs:_builds", 0, -1)).toEqual(["B", "C"]);
    expect(lines.some((l) => /cleanup: deleted 3 keys; removed builds A; kept C \(current\), B \(previous\)/.test(l))).toBe(true);
  });

  // 7-15 (production verification of 2.0.0-next.0): "cleanup: ... deferred (recently used) a20e5cb" and that
  // build was never looked at again by the pod - old keys only went away through the one-day TTL cap
  it.fails("[7-15] a build deferred at start is removed by a later pass once idle, without another start", async () => {
    seed("A");
    await clean("A", 1000);
    seed("B");
    await clean("B", 2000);
    mini.age(HOUR);
    mini.touch("docs:A:e:/docs/p1"); // an old instance still reads A while the new one starts
    const { done } = startCacheMaintenance({ config: config({ logger: false }), cleanup: { minIdleSeconds: 1 } });
    expect((await done).cleanup).toMatchObject({ gaveUp: false, value: { deferredBuilds: ["A"] } });
    // nobody reads A any more: it is removed within minIdleSeconds (+ a margin)
    await waitFor(() => !buildsLeft().includes("A"), { timeout: 4000, message: "A removed without a restart" });
    expect(buildsLeft()).toEqual(["B"]);
  });

  it("skips without a client or while disabled, and never rejects", async () => {
    expect(await startCacheMaintenance({ config: config({ client: null, logger: false }) }).done).toEqual({ skipped: "no-client" });
    expect(await startCacheMaintenance({ config: config({ disabled: true }) }).done).toEqual({ skipped: "disabled" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await startCacheMaintenance({ config: { ...config(), namespace: "bad*ns" } }).done).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("gives up without blocking when Redis never comes up, and says why", async () => {
    const lines: string[] = [];
    const url = `redis://127.0.0.1:${await deadPort()}`;
    const { done } = startCacheMaintenance({
      config: { client: () => connectRedis(url, { waitMs: 50, logger: false }), namespace: "docs", buildId: "C", disabled: false, logger: { warn: (m) => lines.push(String(m)), info: () => {} } },
      cleanup: { attempts: 3, baseDelayMs: 10 },
    });
    const result = await done;
    expect(result.cleanup).toMatchObject({ gaveUp: true, cause: "disconnected", attempts: 3 });
    expect(lines.some((l) => l.includes("cleanup gave up after 3 attempts: Redis not connected"))).toBe(true);
  });

  it("prewarm: true runs the build-output prewarm once Redis is ready", async () => {
    const { done } = startCacheMaintenance({
      config: config({ logger: false }),
      cleanup: false,
      prewarm: { distDir: new URL("../fixtures/next-build/.next/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") },
    });
    const result = await done;
    expect(result.cleanup).toBeUndefined();
    expect(result.prewarm).toMatchObject({ gaveUp: false, value: { prewarmed: 4 } });
    await waitFor(() => mini.keys().includes("docs:C:e:/about"), { message: "prewarmed key" });
  });
});
