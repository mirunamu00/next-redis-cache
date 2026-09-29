// Self-tests for the mini-redis fixture: a real @redis/client must see the same command semantics and
// connection lifecycle (outage, recovery, unresponsive server, auth) that the fault layer relies on.
// No Docker needed; runs on Windows CI too.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESP_TYPES } from "@redis/client";
import { startMiniRedis, type MiniRedis } from "../support/mini-redis";
import { connectTestClient, type TrackedClient } from "../support/redis";
import { deadPort } from "../support/net";
import { timed, waitFor } from "../support/wait-for";

let mini: MiniRedis;
const opened: TrackedClient[] = [];

async function connect(url: string, opts?: Parameters<typeof connectTestClient>[1]): Promise<TrackedClient> {
  const tracked = await connectTestClient(url, opts);
  opened.push(tracked);
  return tracked;
}

beforeEach(async () => {
  mini = await startMiniRedis();
});

afterEach(async () => {
  for (const c of opened.splice(0)) c.close();
  await mini.stop();
});

describe("commands", () => {
  it("answers PING, SET/GET and DEL through a real client", async () => {
    const { client } = await connect(mini.url);
    expect(await client.ping()).toBe("PONG");
    expect(await client.set("k", "v")).toBe("OK");
    expect(await client.get("k")).toBe("v");
    expect(await client.get("missing")).toBeNull();
    expect(await client.del("k")).toBe(1);
    expect(await client.exists("k")).toBe(0);
  });

  it("implements SET NX and EX/PX with TTL and PTTL", async () => {
    const { client } = await connect(mini.url);
    expect(await client.set("k", "first", { condition: "NX", expiration: { type: "EX", value: 60 } })).toBe("OK");
    expect(await client.set("k", "second", { condition: "NX" })).toBeNull();
    expect(await client.get("k")).toBe("first");
    const ttl = await client.ttl("k");
    expect(ttl).toBeGreaterThan(58);
    expect(ttl).toBeLessThanOrEqual(60);
    const pttl = await client.pTTL("k");
    expect(pttl).toBeGreaterThan(58_000);
    expect(pttl).toBeLessThanOrEqual(60_000);
    expect(await client.ttl("missing")).toBe(-2);
    await client.set("forever", "x");
    expect(await client.ttl("forever")).toBe(-1);
  });

  it("expires keys lazily after PX", async () => {
    const { client } = await connect(mini.url);
    await client.set("short", "x", { expiration: { type: "PX", value: 50 } });
    await waitFor(async () => (await client.get("short")) === null, { timeout: 2000, message: "key expiry" });
    expect(await client.exists("short")).toBe(0);
  });

  it("stores binary values byte-exact", async () => {
    const { client } = await connect(mini.url);
    const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x24, 0x2a, 0x80, 0xfe]);
    await client.set("bin", bytes);
    const raw = await client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer }).get("bin");
    expect(Buffer.isBuffer(raw)).toBe(true);
    expect((raw as unknown as Buffer).equals(bytes)).toBe(true);
    expect(mini.getBuffer("bin")?.equals(bytes)).toBe(true);
  });

  it("implements hash commands (HSET, HMGET, HEXISTS, HDEL, HSCAN, HGETALL)", async () => {
    const { client } = await connect(mini.url);
    expect(await client.hSet("h", { a: "1", b: "2" })).toBe(2);
    expect(await client.hSet("h", "a", "3")).toBe(0);
    expect(await client.hmGet("h", ["a", "b", "c"])).toEqual(["3", "2", null]);
    expect(await client.hExists("h", "b")).toBe(1);
    expect(await client.hGetAll("h")).toEqual({ a: "3", b: "2" });
    const scanned = await client.hScan("h", "0");
    expect(scanned.cursor).toBe("0");
    expect(scanned.entries).toEqual([
      { field: "a", value: "3" },
      { field: "b", value: "2" },
    ]);
    expect(await client.hDel("h", ["a", "b"])).toBe(2);
    expect(await client.exists("h")).toBe(0);
  });

  it("implements sorted set commands (ZADD, ZRANGE, ZREM)", async () => {
    const { client } = await connect(mini.url);
    await client.zAdd("z", [
      { score: 3, value: "c" },
      { score: 1, value: "a" },
      { score: 2, value: "b" },
    ]);
    expect(await client.zRange("z", 0, -1)).toEqual(["a", "b", "c"]);
    expect(await client.zRange("z", 0, 0)).toEqual(["a"]);
    expect(await client.zRem("z", "b")).toBe(1);
    expect(await client.zRange("z", 0, -1)).toEqual(["a", "c"]);
  });

  it("implements SCAN MATCH, UNLINK, DBSIZE and FLUSHALL", async () => {
    const { client } = await connect(mini.url);
    for (const k of ["ns:a", "ns:b", "other:c"]) await client.set(k, "1");
    const found: string[] = [];
    for await (const batch of client.scanIterator({ MATCH: "ns:*" })) found.push(...batch);
    expect(found.sort()).toEqual(["ns:a", "ns:b"]);
    expect(await client.unlink(found)).toBe(2);
    expect(await client.dbSize()).toBe(1);
    await client.flushAll();
    expect(mini.keys()).toEqual([]);
  });

  it("tracks idle time: reads reset it, TTL and OBJECT do not", async () => {
    const { client } = await connect(mini.url);
    await client.set("k", "v");
    mini.age(100);
    expect(await client.objectIdleTime("k")).toBeGreaterThanOrEqual(100);
    await client.ttl("k");
    expect(mini.idle("k")).toBeGreaterThanOrEqual(100);
    await client.get("k");
    expect(await client.objectIdleTime("k")).toBe(0);
  });

  it("rejects unknown commands with an error reply", async () => {
    const { client } = await connect(mini.url);
    await expect(client.sendCommand(["NOPE"])).rejects.toThrow(/unknown command/);
    expect(mini.calls.some(([c]) => c === "NOPE")).toBe(true);
  });
});

describe("connection lifecycle", () => {
  it("stop() drops clients; start() on the same port lets them reconnect with data kept", async () => {
    const { client, errors } = await connect(mini.url, { reconnect: 50 });
    await client.set("k", "kept");
    await mini.stop();
    await waitFor(() => !client.isReady, { timeout: 2000, message: "client notices the outage" });
    expect(errors.length).toBeGreaterThan(0);
    await mini.start();
    await waitFor(() => client.isReady, { timeout: 5000, message: "client reconnects" });
    expect(await client.get("k")).toBe("kept");
  });

  it("hang(true) leaves commands unanswered; hang(false) drops connections so the client recovers", async () => {
    const { client } = await connect(mini.url, { reconnect: 50 });
    mini.hang(true);
    const pending = client.ping().then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    const winner = await Promise.race([pending, new Promise((r) => setTimeout(() => r("still pending"), 300))]);
    expect(winner).toBe("still pending");
    mini.hang(false);
    const settled = await pending;
    expect(settled.ok).toBe(false);
    await waitFor(() => client.isReady, { timeout: 5000, message: "client reconnects after hang" });
    expect(await client.ping()).toBe("PONG");
  });

  it("a closed port fails fast when reconnects are disabled", async () => {
    const port = await deadPort();
    const { ms } = await timed(async () => {
      const tracked = await connectTestClient(`redis://127.0.0.1:${port}`, { reconnect: false, lazy: true });
      opened.push(tracked);
      await expect(tracked.client.connect()).rejects.toThrow();
    });
    expect(ms).toBeLessThan(1500);
  });
});

describe("authentication", () => {
  let secured: MiniRedis;

  beforeEach(async () => {
    secured = await startMiniRedis({ password: "test" });
  });

  afterEach(async () => {
    await secured.stop();
  });

  it("accepts the right password", async () => {
    const { client } = await connect(`redis://default:test@127.0.0.1:${secured.port}`);
    expect(await client.ping()).toBe("PONG");
  });

  it("rejects a wrong password during connect", async () => {
    const tracked = await connectTestClient(`redis://default:wrong@127.0.0.1:${secured.port}`, {
      reconnect: false,
      lazy: true,
    });
    opened.push(tracked);
    await expect(tracked.client.connect()).rejects.toThrow(/WRONGPASS/);
  });

  it("answers NOAUTH to unauthenticated commands", async () => {
    const { client } = await connect(secured.url, { reconnect: false });
    await expect(client.ping()).rejects.toThrow(/NOAUTH/);
  });
});
