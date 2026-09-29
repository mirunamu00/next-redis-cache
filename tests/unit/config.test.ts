// Config validation, defaults and build id detection (ROADMAP.md 5.6).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIdResolver, detectBuildId, resolveConfig } from "../../src/config";
import { entryKey, escapeGlob, isReservedOwner, ownerOf, registryKey, tagStateKey, useCacheKey } from "../../src/keys";
import { ttlSeconds } from "../../src/ttl";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveConfig", () => {
  it("applies the documented defaults", () => {
    vi.stubEnv("NEXT_PHASE", "");
    const cfg = resolveConfig({ client: null, namespace: "app" });
    expect(cfg).toMatchObject({
      namespace: "app",
      buildId: undefined,
      readMs: 1000,
      writeMs: 2000,
      openMs: 10_000,
      buildOutput: true,
      reseed: true,
      staticSeconds: 30 * 24 * 3600,
      maxSeconds: 365 * 24 * 3600,
      onTagExpired: "auto",
      compression: "brotli",
      tagStateTtlSeconds: 0,
    });
    expect(cfg.estimateExpire(10)).toBe(15);
    expect(cfg.isDisabled()).toBe(false);
  });

  it("is disabled during next build by default, and when told so", () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    expect(resolveConfig({ client: null, namespace: "a" }).isDisabled()).toBe(true);
    expect(resolveConfig({ client: null, namespace: "a", disabled: false }).isDisabled()).toBe(false);
    let flag = false;
    const cfg = resolveConfig({ client: null, namespace: "a", disabled: () => flag });
    expect(cfg.isDisabled()).toBe(false);
    flag = true;
    expect(cfg.isDisabled()).toBe(true);
  });

  it("turns circuitBreaker: false and fallback: false into switches", () => {
    const cfg = resolveConfig({ client: null, namespace: "a", circuitBreaker: false, fallback: false });
    expect(cfg.openMs).toBe(0);
    expect(cfg.buildOutput).toBe(false);
    expect(cfg.reseed).toBe(false);
  });

  it.each([
    [{ namespace: "" }, /namespace/],
    [{ namespace: "a*b" }, /namespace/],
    [{ namespace: "a b" }, /namespace/],
    [{ namespace: "a", buildId: "x:y" }, /buildId/],
    [{ namespace: "a", buildId: "_builds" }, /buildId/],
    [{ namespace: "a", timeouts: { readMs: 0 } }, /readMs/],
    [{ namespace: "a", circuitBreaker: { openMs: -1 } }, /openMs/],
    [{ namespace: "a", compression: "zip" }, /compression/],
    [{ namespace: "a", onTagExpired: "drop" }, /onTagExpired/],
    [{ namespace: "a", tagStateTtlSeconds: 0 }, /tagStateTtlSeconds/],
  ])("rejects invalid options %j", (options, message) => {
    expect(() => resolveConfig({ client: null, ...(options as object) } as never)).toThrow(message);
  });

  it("isolates onEvent exceptions from the caller", () => {
    const cfg = resolveConfig({
      client: null,
      namespace: "a",
      onEvent: () => {
        throw new Error("observer bug");
      },
    });
    expect(() => cfg.emit({ type: "hit", handler: "legacy", key: "k" })).not.toThrow();
  });

  it("logger: false silences everything; a custom logger gets prefixed messages", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveConfig({ client: null, namespace: "a", logger: false }).logger.warn("x");
    expect(warn).not.toHaveBeenCalled();
    const lines: unknown[] = [];
    resolveConfig({ client: null, namespace: "a", logger: { warn: (m) => lines.push(m) } }).logger.warn("hello");
    resolveConfig({ client: null, namespace: "a", logger: { warn: (m) => lines.push(m) } }).logger.info("dropped");
    expect(lines).toEqual(["[next-redis-cache] hello"]);
  });
});

describe("build id detection", () => {
  it("prefers the option, then BUILD_ID, then <distDir>/BUILD_ID", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nrc-bid-"));
    try {
      writeFileSync(path.join(dir, "BUILD_ID"), "from-file\n");
      vi.stubEnv("BUILD_ID", "from-env");
      expect(detectBuildId("explicit", dir)).toBe("explicit");
      expect(detectBuildId(undefined, dir)).toBe("from-env");
      vi.stubEnv("BUILD_ID", "");
      expect(detectBuildId(undefined, dir)).toBe("from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to \"default\" with one warning", () => {
    vi.stubEnv("BUILD_ID", "");
    const warn = vi.fn();
    const resolve = buildIdResolver(resolveConfig({ client: null, namespace: "a", logger: { warn } }));
    const missing = path.join(tmpdir(), "nrc-no-such-dir");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(missing);
    expect(resolve(missing)).toBe("default");
    expect(resolve(missing)).toBe("default");
    cwd.mockRestore();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("keys", () => {
  it("lays out entries under namespace and build, shared state under reserved owners", () => {
    expect(entryKey("docs", "b1", "/about")).toBe("docs:b1:e:/about");
    expect(useCacheKey("docs", "b1", "k")).toBe("docs:b1:u:k");
    expect(tagStateKey("docs")).toBe("docs:_tagstate");
    expect(registryKey("docs")).toBe("docs:_builds");
  });

  it("reads the owner segment of 2.x and 1.x keys", () => {
    expect(ownerOf("docs", "docs:b1:e:/about")).toBe("b1");
    expect(ownerOf("docs", "docs:abc123:/about")).toBe("abc123");
    expect(ownerOf("docs", "docs:_tagstate")).toBe("_tagstate");
    expect(isReservedOwner("_builds")).toBe(true);
    expect(isReservedOwner("b1")).toBe(false);
  });

  it("escapes glob characters for SCAN MATCH", () => {
    expect(escapeGlob("a*b?[c]\\")).toBe("a\\*b\\?\\[c\\]\\\\");
  });
});

describe("ttlSeconds", () => {
  const cfg = resolveConfig({ client: null, namespace: "a" });

  it("uses estimateExpire for numeric revalidate and staticSeconds otherwise, capped at maxSeconds", () => {
    expect(ttlSeconds(cfg, 5)).toBe(7);
    expect(ttlSeconds(cfg, false)).toBe(30 * 24 * 3600);
    expect(ttlSeconds(cfg, undefined)).toBe(30 * 24 * 3600);
    expect(ttlSeconds(cfg, 0)).toBe(30 * 24 * 3600);
    expect(ttlSeconds(cfg, 31_536_000)).toBe(365 * 24 * 3600);
  });

  it("never goes below one second and survives a broken estimateExpire", () => {
    expect(ttlSeconds({ ...cfg, estimateExpire: () => 0.2 }, 1)).toBe(1);
    expect(ttlSeconds({ ...cfg, estimateExpire: () => NaN }, 1)).toBe(30 * 24 * 3600);
  });
});
