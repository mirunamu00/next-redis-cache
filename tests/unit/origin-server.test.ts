import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startOriginServer } from "../../scripts/origin-server.mjs";

type Origin = Awaited<ReturnType<typeof startOriginServer>>;

describe("origin server (test-app data source)", () => {
  let origin: Origin;

  beforeAll(async () => {
    origin = await startOriginServer();
  });
  afterAll(async () => {
    await origin.close();
  });

  it("serves version 1 by default and counts hits per key", async () => {
    const res = await fetch(`${origin.url}/data/a`);
    expect(await res.json()).toMatchObject({ key: "a", version: 1 });
    await fetch(`${origin.url}/data/a`);
    expect(origin.hits("a")).toBe(2);
    expect(await (await fetch(`${origin.url}/hits`)).json()).toEqual({ a: 2 });
  });

  it("bumps versions over HTTP and in-process", async () => {
    expect(await (await fetch(`${origin.url}/data/b`, { method: "POST" })).json()).toEqual({ key: "b", version: 2 });
    expect(origin.bump("b")).toBe(3);
    expect(((await (await fetch(`${origin.url}/data/b`)).json()) as { version: number }).version).toBe(3);
  });

  it("applies per-key and per-request delays", async () => {
    origin.setDelay("slow", 150);
    let t0 = performance.now();
    await fetch(`${origin.url}/data/slow`);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(140);
    t0 = performance.now();
    await fetch(`${origin.url}/data/fast?delay=120`);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(110);
  });

  it("reset clears versions, hits and delays", async () => {
    await fetch(`${origin.url}/reset`, { method: "POST" });
    expect(origin.hits("a")).toBe(0);
    expect(origin.version("b")).toBe(1);
  });
});
