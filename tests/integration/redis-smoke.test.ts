// Integration smoke against real Redis (testcontainers), once per version under test (NRC_REDIS_VERSIONS).
// Pins the command semantics the handlers depend on and the isolation rules every integration test uses:
// per-test namespaces on a shared database, and per-worker logical databases for global operations.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RESP_TYPES } from "@redis/client";
import { redisVersionsUnderTest, startRedisContainer, type RedisServer } from "../support/redis-container";
import { connectTestClient, type TestRedisClient, type TrackedClient } from "../support/redis";
import { uniqueNamespace, workerDatabase } from "../support/namespace";
import { waitFor } from "../support/wait-for";

describe.each(redisVersionsUnderTest())("Redis %s", (version) => {
  let server: RedisServer;
  let tracked: TrackedClient;
  let client: TestRedisClient;

  beforeAll(async () => {
    server = await startRedisContainer(version);
    tracked = await connectTestClient(server.url, { database: workerDatabase() });
    client = tracked.client;
  });

  afterAll(async () => {
    tracked?.close();
    await server?.stop();
  });

  it("runs the requested server version", async () => {
    const info = await client.info("server");
    const match = /redis_version:(\S+)/.exec(info);
    expect(match?.[1]).toMatch(new RegExp(`^${version.replace(".", "\\.")}\\.`));
  });

  it("requires the test password", async () => {
    const anonymous = await connectTestClient(server.url.replace("default:test@", ""), { reconnect: false });
    try {
      await expect(anonymous.client.ping()).rejects.toThrow(/NOAUTH/);
    } finally {
      anonymous.close();
    }
  });

  it("SET NX EX: first write wins, TTL is within range (PTTL)", async () => {
    const key = `${uniqueNamespace()}:page`;
    expect(await client.set(key, "a", { condition: "NX", expiration: { type: "EX", value: 30 } })).toBe("OK");
    expect(await client.set(key, "b", { condition: "NX", expiration: { type: "EX", value: 30 } })).toBeNull();
    expect(await client.get(key)).toBe("a");
    const pttl = await client.pTTL(key);
    expect(pttl).toBeGreaterThan(28_000);
    expect(pttl).toBeLessThanOrEqual(30_000);
  });

  it("expires keys (PX)", async () => {
    const key = `${uniqueNamespace()}:short`;
    await client.set(key, "x", { expiration: { type: "PX", value: 100 } });
    await waitFor(async () => (await client.exists(key)) === 0, { timeout: 3000, message: "key expiry" });
  });

  it("round-trips binary values byte-exact with a Buffer type mapping", async () => {
    const key = `${uniqueNamespace()}:bin`;
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await client.set(key, bytes, { expiration: { type: "EX", value: 30 } });
    const raw = await client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer }).get(key);
    expect((raw as unknown as Buffer).equals(bytes)).toBe(true);
  });

  it("hash fields: HSET / HMGET / HDEL", async () => {
    const key = `${uniqueNamespace()}:_tagstate`;
    await client.hSet(key, { a: "1,2", b: "3,4" });
    expect(await client.hmGet(key, ["a", "b", "missing"])).toEqual(["1,2", "3,4", null]);
    expect(await client.hDel(key, "a")).toBe(1);
    await client.unlink(key);
  });

  it("namespaces isolate keys on a shared database (SCAN MATCH)", async () => {
    const mine = uniqueNamespace();
    const theirs = uniqueNamespace();
    await client.set(`${mine}:1`, "x", { expiration: { type: "EX", value: 30 } });
    await client.set(`${mine}:2`, "x", { expiration: { type: "EX", value: 30 } });
    await client.set(`${theirs}:1`, "x", { expiration: { type: "EX", value: 30 } });
    const found: string[] = [];
    for await (const batch of client.scanIterator({ MATCH: `${mine}:*`, COUNT: 100 })) found.push(...batch);
    expect(found.sort()).toEqual([`${mine}:1`, `${mine}:2`]);
  });

  it("the worker database is isolated: FLUSHDB there leaves other databases alone", async () => {
    const own = workerDatabase();
    const other = (own + 1) % 16;
    const neighbour = await connectTestClient(server.url, { database: other });
    try {
      const key = `${uniqueNamespace()}:survivor`;
      await neighbour.client.set(key, "x", { expiration: { type: "EX", value: 30 } });
      await client.set(`${uniqueNamespace()}:victim`, "x");
      await client.flushDb();
      expect(await client.dbSize()).toBe(0);
      expect(await neighbour.client.get(key)).toBe("x");
      expect(await client.get(key)).toBeNull();
    } finally {
      neighbour.close();
    }
  });

  it("batched UNLINK removes 1000 keys found by SCAN", async () => {
    const ns = uniqueNamespace();
    const multi = client.multi();
    for (let i = 0; i < 1000; i++) multi.set(`${ns}:${i}`, "v", { expiration: { type: "EX", value: 60 } });
    await multi.exec();
    let removed = 0;
    for await (const batch of client.scanIterator({ MATCH: `${ns}:*`, COUNT: 500 })) {
      if (batch.length > 0) removed += await client.unlink(batch);
    }
    expect(removed).toBe(1000);
    const left: string[] = [];
    for await (const batch of client.scanIterator({ MATCH: `${ns}:*`, COUNT: 500 })) left.push(...batch);
    expect(left).toEqual([]);
  });

  it("HEXPIRE availability matches the version (Q8: optional, Redis >= 7.4 only)", async () => {
    const key = `${uniqueNamespace()}:_tagstate`;
    await client.hSet(key, "t", "1,2");
    const attempt = client.sendCommand(["HEXPIRE", key, "60", "FIELDS", "1", "t"]);
    if (version === "7.2") {
      await expect(attempt).rejects.toThrow(/unknown command/i);
    } else {
      await expect(attempt).resolves.toEqual([1]);
    }
    await client.unlink(key);
  });
});
