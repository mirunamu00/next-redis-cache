// Transition-based failure logging (ROADMAP.md 7-7, D13): one warning per outage, a summary at most once a
// minute while it lasts, one recovery message.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailureReporter, reportFailure, resolveLogger } from "../../src/logger";
import { RedisTimeoutError, RedisUnavailableError } from "../../src/runner";

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const reporter = (label: string) => new FailureReporter(label, resolveLogger(undefined));

describe("FailureReporter", () => {
  it("stays silent while everything succeeds", () => {
    const r = reporter("test");
    r.success();
    r.success();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("warns on the first failure with the operation, key and reason", () => {
    const r = reporter("use-cache");
    r.failure("get", "k1", new Error("boom"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/\[next-redis-cache\] use-cache get failed \(k1\): boom/);
    expect(r.failing).toBe(true);
  });

  it("summarizes further failures at most once per minute", () => {
    const r = reporter("legacy");
    r.failure("get", "k", new Error("down"));
    for (let i = 0; i < 100; i++) r.failure("get", `k${i}`, new Error("down"));
    expect(warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    r.failure("set", "last", new Error("down"));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toMatch(/101 more errors.*set last/);
  });

  it("reports the recovery once and warns again on the next outage", () => {
    const r = reporter("legacy");
    r.failure("get", "k", "string reason");
    r.failure("get", "k", "string reason");
    r.success();
    r.success();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/recovered \(1 errors/);
    r.failure("get", "k", new Error("again"));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("shortens very long cache keys", () => {
    reporter("use-cache").failure("get", "x".repeat(500), new Error("e"));
    expect(String(warn.mock.calls[0]?.[0]).length).toBeLessThan(300);
  });
});

describe("reportFailure", () => {
  it("does not treat an intentionally absent client or a disabled handler as a failure", () => {
    const r = reporter("legacy");
    const emit = vi.fn();
    reportFailure(r, { emit }, "legacy", "get", "k", new RedisUnavailableError("no-client"));
    reportFailure(r, { emit }, "legacy", "get", "k", new RedisUnavailableError("disabled"));
    expect(warn).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("logs unavailability without an error event, and emits real errors", () => {
    const r = reporter("legacy");
    const emit = vi.fn();
    reportFailure(r, { emit }, "legacy", "get", "k", new RedisUnavailableError("not-ready"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
    const err = new RedisTimeoutError(5);
    reportFailure(r, { emit }, "legacy", "set", "k", err);
    expect(emit).toHaveBeenCalledWith({ type: "error", handler: "legacy", op: "set", key: "k", error: err });
  });
});
