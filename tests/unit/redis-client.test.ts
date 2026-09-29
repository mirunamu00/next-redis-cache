// Connection readiness check and timeout wrapper.
// (The timer leak, issue 7-10, is covered by tests/unit/repro.test.ts.)
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RedisClientType } from "@redis/client";
import { assertClientReady, withTimeout } from "../../src/redis-client";

afterEach(() => {
  vi.useRealTimers();
});

describe("assertClientReady", () => {
  it("throws when isReady is false", () => {
    expect(() => assertClientReady({ isReady: false } as RedisClientType)).toThrow(/not ready/);
  });

  it("passes when isReady is true", () => {
    expect(() => assertClientReady({ isReady: true } as RedisClientType)).not.toThrow();
  });
});

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
    const assertion = expect(pending).rejects.toThrow(/timeout \(50ms\)/);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });
});
