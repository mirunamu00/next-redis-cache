// What the handlers report (ROADMAP.md 7-7): only Redis round trips count. A failed render is not a Redis
// failure, a call that never reaches Redis is not a recovery, and an absent client is not an outage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRedis } from "../support/fake-redis";
import { legacyHandler, useCacheEntry, useCacheHandler } from "../support/handlers";

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("use-cache handler error reporting", () => {
  it("reports a failed SET once with the key and reason", async () => {
    const { fake, client } = fakeRedis();
    fake.failOn.set("set", new Error("OOM command not allowed"));
    const { handler } = useCacheHandler({ client });
    await handler.set("k", Promise.resolve(useCacheEntry()));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/use-cache set failed \(k\): OOM/);
  });

  it("calls without tags reach no Redis command and do not count as a recovery", async () => {
    const { fake, client } = fakeRedis();
    const { handler } = useCacheHandler({ client });
    fake.isReady = false;
    expect(await handler.get("k", [])).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await handler.getExpiration([])).toBe(Infinity);
    await handler.updateTags([]);
    expect(info).not.toHaveBeenCalled();
  });

  it("a missing client (no REDIS_URL) is logged once as info, never as a failure", async () => {
    const { handler } = useCacheHandler({ client: () => null });
    for (let i = 0; i < 5; i++) expect(await handler.get(`k${i}`, [])).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe("legacy handler error reporting", () => {
  it("a failed revalidateTag is reported (the invalidation is lost)", async () => {
    const { fake, client } = fakeRedis();
    fake.failOn.set("hSet", new Error("READONLY You can't write against a read only replica"));
    const { handler } = legacyHandler({ client });
    await handler.revalidateTag("t");
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/legacy revalidateTag failed \(t\): READONLY/);
  });

  it("an entry whose tag state cannot be read is served as it is", async () => {
    const { fake, client } = fakeRedis();
    const { handler } = legacyHandler({ client });
    await handler.set("/p", { kind: "APP_ROUTE", body: Buffer.from("x"), status: 200, headers: { "x-next-cache-tags": "t" } }, {});
    fake.failOn.set("hmGet", new Error("LOADING Redis is loading the dataset in memory"));
    expect(await handler.get("/p", { kind: "APP_ROUTE" })).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
