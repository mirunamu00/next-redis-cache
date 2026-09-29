// connectRedis (ROADMAP.md 7-2, section 5.3) against a scripted client: the wait bound, transition-only
// logging, credential redaction and the per-process registry. No sockets - @redis/client's createClient is
// replaced by a client whose connect() and events each test drives (the fault layer covers real sockets).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedClients, connectRedis, DEFAULT_CONNECT_WAIT_MS } from "../../src/redis";

type ConnectBehavior = "ready" | "hang" | "reject";

class ScriptedClient {
  isReady = false;
  isOpen = false;
  destroyed = 0;
  readonly listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  settle: { resolve: () => void; reject: (e: Error) => void } | undefined;

  constructor(
    readonly options: Record<string, unknown>,
    readonly behavior: ConnectBehavior,
  ) {}

  on(event: string, fn: (...a: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    if (event === "ready") this.isReady = true;
    if (event === "error") this.isReady = false;
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }

  connect() {
    this.isOpen = true;
    if (this.behavior === "ready") {
      this.emit("ready");
      return Promise.resolve(this);
    }
    if (this.behavior === "reject") return Promise.reject(new Error("ECONNREFUSED 127.0.0.1:1"));
    return new Promise<this>((resolve, reject) => {
      this.settle = { resolve: () => resolve(this), reject };
    });
  }

  destroy() {
    this.destroyed += 1;
    this.isOpen = false;
    this.isReady = false;
  }
}

const h = vi.hoisted(() => ({
  created: [] as ScriptedClient[],
  behavior: "ready" as "ready" | "hang" | "reject" | "throw",
}));

vi.mock("@redis/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@redis/client")>();
  return {
    ...mod,
    createClient: (options: Record<string, unknown>) => {
      if (h.behavior === "throw") throw new TypeError("Invalid URL");
      const c = new ScriptedClient(options, h.behavior);
      h.created.push(c);
      return c;
    },
  };
});

let lines: Array<[string, string]>;
const logger = () => ({
  debug: (m: unknown) => void lines.push(["debug", String(m)]),
  info: (m: unknown) => void lines.push(["info", String(m)]),
  warn: (m: unknown) => void lines.push(["warn", String(m)]),
  error: (m: unknown) => void lines.push(["error", String(m)]),
});
const text = () => lines.map(([level, m]) => `${level} ${m}`);
const REGISTRY = Symbol.for("@mirunamu/next-redis-cache/clients");

/** Fakes only setTimeout/clearTimeout: setImmediate stays real, so created() can wait for the import. */
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

/**
 * Waits (in real time) until connectRedis created its n-th client. open() imports @redis/client first,
 * which can take a macrotask; fake time may only be advanced once the waitMs timer exists, which is set
 * right after createClient (a run under load advanced it too early and hung in closeSharedClients).
 */
async function created(n = 1): Promise<ScriptedClient> {
  const deadline = performance.now() + 5000;
  while (h.created.length < n) {
    if (performance.now() > deadline) throw new Error("createClient was not called");
    await new Promise((r) => setImmediate(r));
  }
  return h.created[n - 1]!;
}

beforeEach(() => {
  lines = [];
  h.created.length = 0;
  h.behavior = "ready";
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeSharedClients();
});

describe("connectRedis", () => {
  it("returns null without a URL and creates no client", async () => {
    expect(await connectRedis(undefined)).toBeNull();
    expect(await connectRedis(null)).toBeNull();
    expect(await connectRedis("")).toBeNull();
    expect(h.created).toHaveLength(0);
  });

  it("passes the client options through, always with the given URL", async () => {
    const c = (await connectRedis("redis://h1:6379", {
      clientOptions: { socket: { connectTimeout: 5 }, url: "redis://other:1" } as never,
      logger: logger(),
    })) as unknown as ScriptedClient;
    expect(c).toBe(h.created[0]);
    expect(c.options).toEqual({ socket: { connectTimeout: 5 }, url: "redis://h1:6379" });
    expect(c.isReady).toBe(true);
    expect(lines).toEqual([]);
  });

  it("answers as soon as the client is ready, without waiting for waitMs", async () => {
    fakeTimers();
    let settled = false;
    const p = connectRedis("redis://h2:6379", { logger: logger() }).then(() => (settled = true));
    await created();
    await new Promise((r) => setImmediate(r)); // no fake time passes
    expect(settled).toBe(true);
    await p;
    expect(lines).toEqual([]);
  });

  it("waits DEFAULT_CONNECT_WAIT_MS (1000) by default, then returns the connecting client with one warning", async () => {
    expect(DEFAULT_CONNECT_WAIT_MS).toBe(1000);
    fakeTimers();
    h.behavior = "hang";
    let client: unknown;
    const p = connectRedis("redis://h3:6379", { logger: logger() }).then((c) => (client = c));
    await created();
    await vi.advanceTimersByTimeAsync(999);
    expect(client).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(client).toBe(h.created[0]);
    expect(text()).toEqual(["warn [next-redis-cache] redis: not connected within 1000ms; connecting in the background"]);
  });

  it("uses waitMs and the label in its log lines", async () => {
    fakeTimers();
    h.behavior = "hang";
    const p = connectRedis("redis://h4:6379", { waitMs: 50, label: "docs", logger: logger() });
    await created();
    await vi.advanceTimersByTimeAsync(50);
    const c = (await p) as unknown as ScriptedClient;
    expect(c.isReady).toBe(false);
    c.emit("error", new Error("ECONNREFUSED")); // the same outage: no second warning
    expect(text()).toEqual(["warn [next-redis-cache] docs: not connected within 50ms; connecting in the background"]);
  });

  it("does not warn when the client is ready although connect() has not settled", async () => {
    fakeTimers();
    h.behavior = "hang";
    const p = connectRedis("redis://h5:6379", { waitMs: 10, logger: logger() });
    (await created()).emit("ready");
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(lines).toEqual([]);
  });

  it("a rejected connect is logged as an error with the redacted URL, and the client is still returned", async () => {
    h.behavior = "reject";
    const c = await connectRedis("redis://user:s3cret@h6:6379/0", { waitMs: 10_000, logger: logger() });
    expect(c).toBe(h.created[0]);
    const out = text().join("\n");
    expect(out).toContain("error [next-redis-cache] redis: gave up connecting to redis://user:***@h6:6379/0: ECONNREFUSED 127.0.0.1:1");
    expect(out).not.toContain("s3cret");
  });

  it("a URL without a password is logged unchanged, an unparsable one as <invalid url>", async () => {
    h.behavior = "reject";
    await connectRedis("redis://h7:6379", { waitMs: 10, logger: logger() });
    await connectRedis("not a url", { waitMs: 10, logger: logger() });
    expect(lines.filter(([l]) => l === "error").map(([, m]) => m)).toEqual([
      "[next-redis-cache] redis: gave up connecting to redis://h7:6379: ECONNREFUSED 127.0.0.1:1",
      "[next-redis-cache] redis: gave up connecting to <invalid url>: ECONNREFUSED 127.0.0.1:1",
    ]);
  });

  it("logger: false is silent", async () => {
    fakeTimers();
    h.behavior = "hang";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = connectRedis("redis://h8:6379", { waitMs: 5, logger: false });
    await created();
    await vi.advanceTimersByTimeAsync(5);
    await p;
    h.created[0]!.emit("error", new Error("boom"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs outage and recovery transitions only, never one line per reconnect attempt", async () => {
    fakeTimers();
    h.behavior = "hang";
    const p = connectRedis("redis://:pw@h9:6379", { waitMs: 100, logger: logger() });
    const c = await created();
    c.emit("error", new Error("ECONNREFUSED 1"));
    c.emit("error", new Error("ECONNREFUSED 2"));
    await vi.advanceTimersByTimeAsync(100);
    await p;
    // one warning for the outage; the wait does not add a second one
    expect(text()).toEqual([
      "warn [next-redis-cache] redis: Redis unavailable (ECONNREFUSED 1); caching without Redis until it reconnects",
    ]);
    c.emit("ready");
    expect(text().at(-1)?.startsWith("info [next-redis-cache] redis: connected to redis://:***@h9:6379")).toBe(true);
    c.emit("ready"); // already healthy: nothing new
    c.emit("error", "socket closed"); // healthy -> failing: warns again (non-Error values are described too)
    c.emit("error", new Error("ECONNREFUSED 3"));
    expect(text().slice(2)).toEqual([
      "warn [next-redis-cache] redis: Redis unavailable (socket closed); caching without Redis until it reconnects",
    ]);
    c.emit("ready");
    expect(text().length).toBe(4);
    expect(text().at(-1)).toBe("info [next-redis-cache] redis: connected to redis://:***@h9:6379 again");
  });

  // 7-14 (production verification of 2.0.0-next.0): "docs: not connected within 1000ms; connecting in the
  // background" was followed by "docs: connected to redis://... again" although it never had been connected
  it("[7-14] the first connection after a slow start is not logged as a reconnection", async () => {
    fakeTimers();
    h.behavior = "hang";
    const p = connectRedis("redis://h11:6379", { waitMs: 100, label: "docs", logger: logger() });
    await created();
    await vi.advanceTimersByTimeAsync(100);
    await p;
    h.created[0]!.emit("ready");
    expect(text()).toEqual([
      "warn [next-redis-cache] docs: not connected within 100ms; connecting in the background",
      "info [next-redis-cache] docs: connected to redis://h11:6379",
    ]);
  });

  it("a first error after a healthy start warns; a ready without a prior warning logs nothing", async () => {
    const c = (await connectRedis("redis://h10:6379", { logger: logger() })) as unknown as ScriptedClient;
    c.emit("ready");
    expect(lines).toEqual([]);
    c.emit("error", new Error("READONLY"));
    expect(text()).toEqual(["warn [next-redis-cache] redis: Redis unavailable (READONLY); caching without Redis until it reconnects"]);
  });
});

describe("shared clients", () => {
  it("one client per URL in a registry on globalThis, shared by concurrent callers", async () => {
    const [a, b] = await Promise.all([connectRedis("redis://s1:6379"), connectRedis("redis://s1:6379")]);
    expect(a).toBe(b);
    expect(h.created).toHaveLength(1);
    const registry = (globalThis as unknown as Record<symbol, Map<string, Promise<unknown>>>)[REGISTRY];
    expect(registry).toBeInstanceOf(Map);
    expect(await registry.get("redis://s1:6379")).toBe(a);
    const other = await connectRedis("redis://s2:6379");
    expect(other).not.toBe(a);
    expect(h.created).toHaveLength(2);
  });

  it("shared: false opens a private client that the registry does not keep", async () => {
    const own = await connectRedis("redis://s3:6379", { shared: false });
    const shared = await connectRedis("redis://s3:6379");
    const again = await connectRedis("redis://s3:6379", { shared: false });
    expect(new Set([own, shared, again]).size).toBe(3);
    expect(await connectRedis("redis://s3:6379")).toBe(shared);
    expect(h.created).toHaveLength(3);
  });

  it("a client that cannot be created is not kept: the next call tries again", async () => {
    h.behavior = "throw";
    await expect(connectRedis("redis://s4:6379")).rejects.toThrow("Invalid URL");
    await Promise.resolve();
    h.behavior = "ready";
    expect(await connectRedis("redis://s4:6379")).toBe(h.created[0]);
  });

  it("closeSharedClients destroys the open clients, skips closed and failed ones, and empties the registry", async () => {
    const a = (await connectRedis("redis://s5:6379")) as unknown as ScriptedClient;
    const b = (await connectRedis("redis://s6:6379")) as unknown as ScriptedClient;
    b.destroy(); // closed by its owner already
    h.behavior = "throw";
    await expect(connectRedis("redis://s7:6379")).rejects.toThrow();
    const registry = (globalThis as unknown as Record<symbol, Map<string, Promise<unknown>>>)[REGISTRY];
    const failed = Promise.reject(new Error("never opened"));
    failed.catch(() => undefined);
    registry.set("redis://s8:6379", failed);
    await closeSharedClients();
    expect(a.destroyed).toBe(1);
    expect(b.destroyed).toBe(1);
    expect(registry.size).toBe(0);
    h.behavior = "ready";
    const fresh = await connectRedis("redis://s5:6379");
    expect(fresh).not.toBe(a);
  });
});
