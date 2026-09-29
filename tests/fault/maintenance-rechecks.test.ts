// Rechecks of deferred builds (ROADMAP.md 7-15) with mini-redis. Every test waits for real timers
// (minIdleSeconds + 1 s between passes), so each one gets its own mini-redis and they run concurrently.
//
// 7-15 (production verification of 2.0.0-next.0): "cleanup: ... deferred (recently used) a20e5cb" and that
// build was never looked at again by the pod - old keys only went away through the one-day TTL cap.
import { describe, expect, it } from "vitest";
import { createClient } from "@redis/client";
import { startMiniRedis } from "../support/mini-redis";
import { waitFor } from "../support/wait-for";
import { cleanupOldBuilds, startCacheMaintenance, type MaintenanceOptions } from "../../src/maintenance";
import type { RedisCacheConfig } from "../../src/types";

const WEEK = 7 * 24 * 3600;
const HOUR = 3600;

/** A mini-redis, a client and helpers for one test; `close()` stops the maintenance runs and both servers. */
async function env() {
  const mini = await startMiniRedis();
  const client = createClient({ url: mini.url });
  client.on("error", () => {});
  await client.connect();
  const stops: Array<() => void> = [];
  const seed = (build: string, n = 3) => {
    for (let i = 0; i < n; i++) mini.setString(`docs:${build}:e:/docs/p${i}`, "x", WEEK);
  };
  return {
    mini,
    client,
    seed,
    clean: (buildId: string, now: number) => cleanupOldBuilds(client as never, { namespace: "docs", buildId, now }),
    buildsLeft: () => [...new Set(mini.keys().filter((k) => !k.startsWith("docs:_")).map((k) => k.split(":")[1]))].sort(),
    /** startCacheMaintenance for build C (config overridable), stopped by close(). */
    maintain(config: Partial<RedisCacheConfig>, cleanup: NonNullable<MaintenanceOptions["cleanup"]>) {
      const m = startCacheMaintenance({ config: { client: client as never, namespace: "docs", buildId: "C", disabled: false, ...config }, cleanup });
      stops.push(m.stop);
      return m;
    },
    async close() {
      for (const stop of stops) stop();
      client.destroy();
      await mini.stop();
    },
  };
}

const infoInto = (lines: string[]) => ({ info: (m: unknown) => void lines.push(String(m)) });

/** The client with OBJECT IDLETIME failing like under an LFU policy: every old build counts as in use. */
function withoutIdleTime<T extends object>(c: T): T {
  return new Proxy(c, {
    get(target, prop) {
      if (prop === "objectIdleTime") return () => Promise.reject(new Error("ERR An LFU maxmemory policy is selected, idle time not tracked"));
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/**
 * The client with every key reported as just used until `release()`: the start pass defers every old build
 * however long it takes on a busy machine (a real idle time then decides at the rechecks).
 */
function inUseUntilReleased<T extends object>(c: T) {
  let inUse = true;
  const client = new Proxy(c, {
    get(target, prop) {
      if (prop === "objectIdleTime" && inUse) return () => Promise.resolve(0);
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { client, release: () => void (inUse = false) };
}

describe.concurrent("rechecks of deferred builds (7-15)", () => {
  it("[7-15] a build deferred at start is removed by a later pass once idle, without another start", async () => {
    const e = await env();
    try {
      const lines: string[] = [];
      e.seed("A");
      await e.clean("A", 1000);
      e.seed("B");
      await e.clean("B", 2000);
      e.mini.age(HOUR);
      const old = inUseUntilReleased(e.client); // an old instance still reads A while the new one starts
      const { done } = e.maintain({ client: old.client as never, logger: infoInto(lines) }, { minIdleSeconds: 1 });
      expect((await done).cleanup).toMatchObject({ gaveUp: false, value: { deferredBuilds: ["A"] } });
      old.release();
      const registered = await e.client.zScore("docs:_builds", "C");
      // nobody reads A any more: it is removed within minIdleSeconds (+ a margin)
      await waitFor(() => !e.buildsLeft().includes("A"), { timeout: 4000, message: "A removed without a restart" });
      expect(e.buildsLeft()).toEqual(["B"]);
      expect(lines.at(-1)).toBe("[next-redis-cache] cleanup recheck 1 of 3: deleted 3 keys; removed builds A; kept C (current), B (previous)");
      // a recheck does not register the build again
      expect(await e.client.zRange("docs:_builds", 0, -1)).toEqual(["B", "C"]);
      expect(await e.client.zScore("docs:_builds", "C")).toBe(registered);
    } finally {
      await e.close();
    }
  });

  it("rechecks run while builds stay deferred, at most `rechecks` times; none with rechecks: 0 or after stop()", async () => {
    const e = await env();
    try {
      const lines = { two: [] as string[], none: [] as string[], stopped: [] as string[] };
      e.seed("old");
      const lfu = withoutIdleTime(e.client); // "old" stays deferred on every pass
      const two = e.maintain({ client: lfu as never, logger: infoInto(lines.two) }, { minIdleSeconds: 0, rechecks: 2 });
      const none = e.maintain({ client: lfu as never, logger: infoInto(lines.none) }, { minIdleSeconds: 0, rechecks: 0 });
      const stopped = e.maintain({ client: lfu as never, logger: infoInto(lines.stopped) }, { minIdleSeconds: 0, rechecks: 2 });
      await Promise.all([two.done, none.done, stopped.done]);
      stopped.stop();
      await waitFor(() => lines.two.length === 3, { timeout: 5000, message: "two rechecks" });
      await new Promise((r) => setTimeout(r, 1300));
      expect(lines.two.slice(1)).toEqual([
        "[next-redis-cache] cleanup recheck 1 of 2: deleted 0 keys; kept C (current); deferred (recently used) old",
        "[next-redis-cache] cleanup recheck 2 of 2: deleted 0 keys; kept C (current); deferred (recently used) old",
      ]);
      expect(lines.none).toHaveLength(1);
      expect(lines.stopped).toHaveLength(1);
      expect(e.buildsLeft()).toEqual(["old"]);
    } finally {
      await e.close();
    }
  });

  it("no recheck when nothing was deferred", async () => {
    const e = await env();
    try {
      e.seed("A");
      e.mini.age(HOUR);
      const { done } = e.maintain({ logger: false }, { minIdleSeconds: 0 });
      expect((await done).cleanup).toMatchObject({ value: { removedBuilds: ["A"], deferredBuilds: [] } });
      const scans = () => e.mini.calls.filter(([c]) => c === "SCAN").length;
      const before = scans();
      await new Promise((r) => setTimeout(r, 1300));
      expect(scans()).toBe(before);
    } finally {
      await e.close();
    }
  });

  it("a recheck while Redis is not ready is skipped and the next one still runs", async () => {
    const e = await env();
    try {
      const lines: string[] = [];
      e.seed("old");
      let ready = true;
      let readinessChecks = 0;
      const flaky = new Proxy(withoutIdleTime(e.client), {
        get(target, prop) {
          if (prop === "isReady") {
            readinessChecks += 1;
            return ready;
          }
          return Reflect.get(target, prop);
        },
      });
      const { done } = e.maintain({ client: flaky as never, logger: infoInto(lines) }, { minIdleSeconds: 0, rechecks: 2 });
      await done;
      ready = false; // the first recheck finds Redis down
      const checked = readinessChecks;
      await waitFor(() => readinessChecks > checked, { timeout: 3000, message: "first recheck" });
      expect(lines).toHaveLength(1);
      ready = true;
      await waitFor(() => lines.length === 2, { timeout: 3000, message: "second recheck" });
      expect(lines[1]).toMatch(/^\[next-redis-cache\] cleanup recheck 2 of 2: /);
    } finally {
      await e.close();
    }
  });

  it("a failing recheck is logged as a warning and retried by the next one", async () => {
    const e = await env();
    try {
      const lines: string[] = [];
      e.seed("old");
      let failing = false;
      const client = new Proxy(withoutIdleTime(e.client), {
        get(target, prop) {
          if (prop === "zRange" && failing) return () => Promise.reject(new Error("LOADING Redis is loading"));
          return Reflect.get(target, prop);
        },
      });
      const { done } = e.maintain(
        { client: client as never, logger: { info: (m: unknown) => void lines.push(`info ${String(m)}`), warn: (m: unknown) => void lines.push(`warn ${String(m)}`) } },
        { minIdleSeconds: 0, rechecks: 2 },
      );
      await done;
      failing = true;
      await waitFor(() => lines.length === 2, { timeout: 3000, message: "failed recheck" });
      expect(lines[1]).toBe("warn [next-redis-cache] cleanup recheck 1 of 2 failed: LOADING Redis is loading");
      failing = false;
      await waitFor(() => lines.length === 3, { timeout: 3000, message: "second recheck" });
      expect(lines[2]).toMatch(/^info \[next-redis-cache\] cleanup recheck 2 of 2: deleted 0 keys/);
    } finally {
      await e.close();
    }
  });

  it("an older instance's recheck keeps the newer deployments and their previous build", async () => {
    const e = await env();
    try {
      const lines: string[] = [];
      e.seed("A");
      await e.clean("A", 1000);
      e.seed("B");
      e.mini.setString("docs:X:e:/orphan", "x", WEEK); // a build still read when B starts
      e.mini.age(HOUR);
      const old = inUseUntilReleased(e.client);
      const { done } = e.maintain({ client: old.client as never, buildId: "B", logger: infoInto(lines) }, { minIdleSeconds: 1 });
      expect((await done).cleanup).toMatchObject({ value: { deferredBuilds: ["X"] } });
      old.release();
      // two more deployments while the B instance still runs
      e.seed("C");
      await e.clean("C", Date.now() + 1000);
      e.seed("D");
      await e.clean("D", Date.now() + 2000);
      await waitFor(() => lines.some((l) => l.includes("cleanup recheck 1 of 3")), { timeout: 5000, message: "recheck of the B instance" });
      // D is the newest and C its previous build: both stay, as does B (still running); A and X were idle
      expect(e.buildsLeft()).toEqual(["B", "C", "D"]);
      expect(lines.at(-1)).toBe("[next-redis-cache] cleanup recheck 1 of 3: deleted 4 keys; removed builds A, X; kept B (current), D (previous), C (previous)");
    } finally {
      await e.close();
    }
  });
});
