// Toxic control smoke: the four toxics the fault and chaos layers depend on (latency, timeout,
// reset_peer, bandwidth) must be controllable from a test and must visibly affect a real
// @redis/client talking to Redis 8.4 through toxiproxy.
// Requires `npm run infra:up` (profiles redis84 + toxiproxy).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ProxyHandle, ToxiproxyClient } from "../support/toxiproxy";
import { connectTestClient, type TrackedClient } from "../support/redis";
import { uniqueNamespace } from "../support/namespace";
import { timed, waitFor } from "../support/wait-for";

const api = new ToxiproxyClient();
let proxy: ProxyHandle;
const opened: TrackedClient[] = [];

async function connect(): Promise<TrackedClient> {
  const tracked = await connectTestClient(proxy.url, { reconnect: 50 });
  opened.push(tracked);
  return tracked;
}

/** Settles a promise into a tagged result so a rejection is asserted, never left unhandled. */
function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

beforeAll(async () => {
  expect(await api.version()).toMatch(/^2\./);
  proxy = await api.workerProxy("redis84:6379");
});

afterEach(async () => {
  for (const c of opened.splice(0)) c.close();
  await proxy.clear();
});

afterAll(async () => {
  await proxy?.destroy();
});

describe("toxiproxy control", () => {
  it("passes traffic untouched without toxics", async () => {
    const { client } = await connect();
    const key = `${uniqueNamespace()}:k`;
    await client.set(key, "v", { expiration: { type: "EX", value: 60 } });
    const { value, ms } = await timed(() => client.get(key));
    expect(value).toBe("v");
    expect(ms).toBeLessThan(250);
  });

  it("latency: adds the configured delay and goes away when removed", async () => {
    const { client } = await connect();
    await client.ping(); // warm up
    const toxic = await proxy.latency(300, 50);
    expect(toxic).toMatchObject({ type: "latency", stream: "downstream", attributes: { latency: 300, jitter: 50 } });
    const slow = await timed(() => client.ping());
    expect(slow.ms).toBeGreaterThanOrEqual(240);
    expect(slow.ms).toBeLessThan(2000);
    await proxy.remove(toxic.name);
    const fast = await timed(() => client.ping());
    expect(fast.ms).toBeLessThan(200);
  });

  it("timeout (0): the server goes silent and in-flight commands never settle", async () => {
    const { client } = await connect();
    await client.ping();
    await proxy.timeout(0);
    const pending = settle(client.ping());
    const winner = await Promise.race([pending, new Promise((r) => setTimeout(() => r("still pending"), 500))]);
    expect(winner).toBe("still pending");
    // Only tearing the client down releases the command; this is the hang that 7-2/7-3 are about
    client.destroy();
    const settled = await pending;
    expect(settled.ok).toBe(false);
  });

  it("timeout (ms): the connection is closed, the command fails and the client recovers once removed", async () => {
    const { client, errors } = await connect();
    await client.ping();
    const toxic = await proxy.timeout(300);
    const { value: settled, ms } = await timed(() => settle(client.ping()));
    expect(settled.ok).toBe(false);
    expect(ms).toBeLessThan(3000);
    await waitFor(() => errors.length > 0, { timeout: 3000, message: "client error event" });
    await proxy.remove(toxic.name);
    await waitFor(() => client.isReady, { timeout: 10_000, message: "client reconnects" });
    expect(await client.ping()).toBe("PONG");
  });

  it("reset_peer: the connection is reset, the command fails and the client recovers once removed", async () => {
    const { client, errors } = await connect();
    await client.ping();
    const toxic = await proxy.resetPeer(0);
    const settled = await settle(client.ping());
    expect(settled.ok).toBe(false);
    await waitFor(() => errors.length > 0, { timeout: 3000, message: "client error event" });
    await proxy.remove(toxic.name);
    await waitFor(() => client.isReady, { timeout: 10_000, message: "client reconnects" });
    expect(await client.ping()).toBe("PONG");
  });

  it("bandwidth: large replies slow down to the configured rate", async () => {
    const { client } = await connect();
    const key = `${uniqueNamespace()}:big`;
    const value = "x".repeat(100 * 1024);
    await client.set(key, value, { expiration: { type: "EX", value: 60 } });
    const baseline = await timed(() => client.get(key));
    expect(baseline.value).toHaveLength(value.length);
    await proxy.bandwidth(100); // 100 KB/s -> about 1s for 100 KiB
    const throttled = await timed(() => client.get(key));
    expect(throttled.value).toHaveLength(value.length);
    expect(throttled.ms).toBeGreaterThanOrEqual(700);
    expect(throttled.ms).toBeGreaterThan(baseline.ms * 3);
  });
});
