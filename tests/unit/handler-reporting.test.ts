// What the handlers report through ErrorReporter (ROADMAP.md 7-7): only Redis round trips count. A failed
// render is not a Redis failure, and a call that never reaches Redis is not a recovery.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUseCacheHandler } from "../../src/use-cache-handler";
import { useCacheEntry } from "../support/handlers";

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeClient() {
  return {
    isReady: true,
    get: vi.fn(() => Promise.resolve(null)),
    set: vi.fn(() => Promise.resolve("OK")),
    hSet: vi.fn(() => Promise.resolve(1)),
    hmGet: vi.fn((_k: string, fields: string[]) => Promise.resolve(fields.map((): string | null => null))),
  };
}

describe("use-cache handler error reporting", () => {
  it("does not report a rejected pending entry (a failed render) as a Redis failure", async () => {
    const client = fakeClient();
    const handler = createUseCacheHandler({ client: client as never, keyPrefix: "t:" });
    await handler.set("k", Promise.reject(new Error("render failed")));
    expect(client.set).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a failed SET", async () => {
    const client = fakeClient();
    client.set.mockImplementation(() => Promise.reject(new Error("OOM command not allowed")));
    const handler = createUseCacheHandler({ client: client as never, keyPrefix: "t:" });
    await handler.set("k", Promise.resolve(useCacheEntry()));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/use-cache set failed \(k\): OOM/);
  });

  it("calls without tags reach no Redis command and do not count as a recovery", async () => {
    const client = fakeClient();
    const handler = createUseCacheHandler({ client: client as never, keyPrefix: "t:" });
    client.isReady = false;
    expect(await handler.get("k", [])).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await handler.getExpiration([])).toBe(0);
    await handler.updateTags([]);
    expect(info).not.toHaveBeenCalled();
  });
});

describe("healing a future tag time left by 1.0.x (7-1)", () => {
  it("is best effort: a failing rewrite does not fail the read", async () => {
    const client = fakeClient();
    const future = String(Date.now() + 365 * 24 * 3600 * 1000);
    client.hmGet.mockImplementation((_k: string, fields: string[]) => Promise.resolve(fields.map(() => future)));
    client.hSet.mockImplementation(() => Promise.reject(new Error("READONLY You can't write against a read only replica")));
    const handler = createUseCacheHandler({ client: client as never, keyPrefix: "t:" });
    const expiration = await handler.getExpiration(["t"]);
    expect(expiration).toBeGreaterThan(Date.now() - 1000);
    expect(expiration).toBeLessThanOrEqual(Date.now());
    expect(client.hSet).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
