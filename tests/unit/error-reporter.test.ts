// Transition-based error reporting (ROADMAP.md 7-7): one warning per outage, a summary at most once a
// minute while it lasts, one recovery message.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorReporter } from "../../src/error-reporter";

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

describe("ErrorReporter", () => {
  it("stays silent while everything succeeds", () => {
    const r = new ErrorReporter("test");
    r.success();
    r.success();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("warns on the first failure with the operation, key and reason", () => {
    const r = new ErrorReporter("use-cache");
    r.failure("get", "k1", new Error("boom"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/\[next-redis-cache\] use-cache get failed \(k1\): boom/);
  });

  it("summarizes further failures at most once per minute", () => {
    const r = new ErrorReporter("legacy");
    r.failure("get", "k", new Error("down"));
    for (let i = 0; i < 100; i++) r.failure("get", `k${i}`, new Error("down"));
    expect(warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    r.failure("set", "last", new Error("down"));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toMatch(/101 more errors.*set last/);
  });

  it("reports the recovery once and warns again on the next outage", () => {
    const r = new ErrorReporter("legacy");
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
    const r = new ErrorReporter("use-cache");
    r.failure("get", "x".repeat(500), new Error("e"));
    expect(String(warn.mock.calls[0]?.[0]).length).toBeLessThan(300);
  });
});
