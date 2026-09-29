// The command pipeline (ROADMAP.md 5.3): nothing is sent while unavailable, every command is bounded by a
// timeout whose timer is cleared, and a timeout opens the circuit breaker (A3).
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../src/config";
import { CLIENT_RESOLVE_MS, RedisTimeoutError, RedisUnavailableError, Runner, withTimeout } from "../../src/runner";
import type { CacheEvent, RedisCacheConfig } from "../../src/types";
import { fakeRedis } from "../support/fake-redis";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function runner(config: Partial<RedisCacheConfig> & Pick<RedisCacheConfig, "client">) {
  const events: CacheEvent[] = [];
  const logs: string[] = [];
  const cfg = resolveConfig({
    namespace: "t",
    disabled: false,
    logger: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`) },
    onEvent: (e) => events.push(e),
    ...config,
  });
  return { runner: new Runner(cfg), events, logs };
}

const reason = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  return err instanceof RedisUnavailableError ? err.reason : err;
};

describe("withTimeout", () => {
  it("resolves with the original value when it settles in time", async () => {
    await expect(withTimeout(Promise.resolve("v"), 1000)).resolves.toBe("v");
  });

  it("rejects with the original error and clears its timer", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with a timeout error when the limit is exceeded", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<never>(() => {}), 50);
    const assertion = expect(pending).rejects.toBeInstanceOf(RedisTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });
});

describe("Runner availability", () => {
  it("sends nothing while the client is not ready", async () => {
    const { fake, client } = fakeRedis({ ready: false });
    const { runner: r } = runner({ client });
    expect(await reason(r.run("read", (c) => c.get("k")))).toBe("not-ready");
    expect(fake.calls).toEqual([]);
  });

  it("sends nothing when disabled", async () => {
    const { fake, client } = fakeRedis();
    const { runner: r } = runner({ client, disabled: true });
    expect(await reason(r.run("read", (c) => c.get("k")))).toBe("disabled");
    expect(fake.calls).toEqual([]);
    expect(r.usable()).toBe(false);
  });

  it("calls a client function until it returns a client, then keeps that client", async () => {
    const { fake, client } = fakeRedis();
    let calls = 0;
    let available = false;
    const { runner: r, logs } = runner({
      client: () => {
        calls += 1;
        return available ? client : null;
      },
    });
    expect(await reason(r.run("read", (c) => c.get("k")))).toBe("no-client");
    expect(await reason(r.run("read", (c) => c.get("k")))).toBe("no-client");
    expect(logs.filter((l) => l.includes("no Redis client"))).toHaveLength(1);
    available = true;
    await r.run("read", (c) => c.get("k"));
    await r.run("read", (c) => c.get("k"));
    expect(calls).toBe(3);
    expect(fake.count("get")).toBe(2);
  });

  it("does not wait forever for a client function that never returns", async () => {
    vi.useFakeTimers();
    const { runner: r } = runner({ client: () => new Promise(() => {}) });
    const result = reason(r.run("read", (c) => c.get("k")));
    await vi.advanceTimersByTimeAsync(CLIENT_RESOLVE_MS);
    expect(await result).toBe("no-client");
  });

  it("a client function that throws is logged and treated as no client", async () => {
    const { runner: r, logs } = runner({
      client: () => {
        throw new Error("bad url");
      },
    });
    expect(await reason(r.run("read", (c) => c.get("k")))).toBe("no-client");
    expect(logs.some((l) => l.includes("bad url"))).toBe(true);
  });
});

describe("circuit breaker", () => {
  it("opens on a timeout, fails fast while open, closes after a success", async () => {
    vi.useFakeTimers();
    const { fake, client } = fakeRedis();
    const { runner: r, events, logs } = runner({ client, timeouts: { readMs: 100 }, circuitBreaker: { openMs: 1000 } });
    fake.hanging = true;
    const first = r.run("read", (c) => c.get("k")).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toBeInstanceOf(RedisTimeoutError);
    expect(events).toContainEqual(expect.objectContaining({ type: "circuit", state: "open" }));
    expect(logs.filter((l) => l.startsWith("warn"))).toHaveLength(1);

    const sent = fake.calls.length;
    for (let i = 0; i < 10; i++) expect(await reason(r.run("read", (c) => c.get("k")))).toBe("circuit-open");
    expect(fake.calls.length).toBe(sent);
    expect(r.usable()).toBe(false);

    fake.hanging = false;
    await vi.advanceTimersByTimeAsync(1000);
    await r.run("read", (c) => c.get("k"));
    expect(events).toContainEqual(expect.objectContaining({ type: "circuit", state: "closed" }));
    expect(r.usable()).toBe(true);
  });

  it("is shared by every runner of the same client", async () => {
    vi.useFakeTimers();
    const { fake, client } = fakeRedis();
    const a = runner({ client, timeouts: { readMs: 50 } }).runner;
    const b = runner({ client, timeouts: { readMs: 50 } }).runner;
    fake.hanging = true;
    const first = a.run("read", (c) => c.get("k")).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(50);
    await first;
    expect(await reason(b.run("read", (c) => c.get("k")))).toBe("circuit-open");
  });

  it("circuitBreaker: false keeps sending (every call waits for its own timeout)", async () => {
    vi.useFakeTimers();
    const { fake, client } = fakeRedis();
    const { runner: r } = runner({ client, timeouts: { readMs: 50 }, circuitBreaker: false });
    fake.hanging = true;
    for (let i = 0; i < 3; i++) {
      const p = r.run("read", (c) => c.get("k")).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(50);
      expect(await p).toBeInstanceOf(RedisTimeoutError);
    }
    expect(fake.count("get")).toBe(3);
  });

  it("command errors (not timeouts) do not open the circuit", async () => {
    const { fake, client } = fakeRedis();
    const { runner: r } = runner({ client });
    fake.failOn.set("get", new Error("WRONGTYPE"));
    await expect(r.run("read", (c) => c.get("k"))).rejects.toThrow("WRONGTYPE");
    fake.failOn.clear();
    await expect(r.run("read", (c) => c.get("k"))).resolves.toBeNull();
  });
});
