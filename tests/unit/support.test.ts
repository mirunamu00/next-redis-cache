// Tests for the shared test helpers (isolation and polling) that every Redis-backed layer relies on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { poolId, uniqueNamespace, workerDatabase } from "../support/namespace";
import { waitFor } from "../support/wait-for";
import { redisVersionsUnderTest } from "../support/redis-versions";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("uniqueNamespace", () => {
  it("is unique per call and scoped to the process id", () => {
    const a = uniqueNamespace();
    const b = uniqueNamespace();
    expect(a).not.toBe(b);
    expect(a).toMatch(new RegExp(`^t_${process.pid}_\\d+$`));
  });

  it("sanitizes the optional label", () => {
    expect(uniqueNamespace("a b/c:d")).toMatch(/_a_b_c_d$/);
  });
});

describe("worker database", () => {
  it("maps the vitest pool id onto databases 0-15", () => {
    vi.stubEnv("VITEST_POOL_ID", "3");
    expect(poolId()).toBe(3);
    expect(workerDatabase()).toBe(3);
    vi.stubEnv("VITEST_POOL_ID", "16");
    expect(workerDatabase()).toBe(0);
  });

  it("falls back to pool 1 when the id is missing or invalid", () => {
    vi.stubEnv("VITEST_POOL_ID", "abc");
    expect(poolId()).toBe(1);
  });
});

describe("waitFor", () => {
  it("returns the first truthy value", async () => {
    let n = 0;
    await expect(waitFor(() => (++n >= 3 ? n : 0), { interval: 1 })).resolves.toBe(3);
  });

  it("fails with the description and last error after the deadline", async () => {
    await expect(
      waitFor(
        () => {
          throw new Error("boom");
        },
        { timeout: 30, interval: 5, message: "the thing" },
      ),
    ).rejects.toThrow(/the thing not met within 30ms; last error: Error: boom/);
  });
});

describe("redisVersionsUnderTest", () => {
  it("defaults to every supported version", () => {
    vi.stubEnv("NRC_REDIS_VERSIONS", "");
    expect(redisVersionsUnderTest()).toEqual(["8.4", "7.2"]);
  });

  it("reads a comma separated list and rejects unknown versions", () => {
    vi.stubEnv("NRC_REDIS_VERSIONS", " 7.2 ");
    expect(redisVersionsUnderTest()).toEqual(["7.2"]);
    vi.stubEnv("NRC_REDIS_VERSIONS", "6.0");
    expect(() => redisVersionsUnderTest()).toThrow(/unsupported/);
  });
});
