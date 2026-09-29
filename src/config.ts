/**
 * Validation and defaults of RedisCacheConfig (ROADMAP.md section 5.6).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CacheEvent, ClientSource, Compression, Logger, RedisCacheConfig } from "./types";
import { resolveLogger, type ResolvedLogger } from "./logger";

export const DEFAULT_READ_MS = 1000;
export const DEFAULT_WRITE_MS = 2000;
export const DEFAULT_OPEN_MS = 10_000;
export const DEFAULT_STATIC_SECONDS = 30 * 24 * 3600;
export const DEFAULT_MAX_SECONDS = 365 * 24 * 3600;
/** Chosen after the P6 measurements (ROADMAP.md D42): -86% memory for a static site, no latency cost. */
export const DEFAULT_COMPRESSION: Compression = "brotli";

export interface ResolvedConfig {
  client: ClientSource;
  namespace: string;
  /** Explicit build id; undefined = resolved lazily (env, then the BUILD_ID file). */
  buildId: string | undefined;
  readMs: number;
  writeMs: number;
  /** 0 = circuit breaker off. */
  openMs: number;
  buildOutput: boolean;
  reseed: boolean;
  staticSeconds: number;
  maxSeconds: number;
  estimateExpire: (revalidateSeconds: number) => number;
  onTagExpired: "auto" | "stale" | "miss";
  compression: Compression;
  /** 0 = tag state fields without TTL (default). */
  tagStateTtlSeconds: number;
  logger: ResolvedLogger;
  emit: (event: CacheEvent) => void;
  isDisabled: () => boolean;
}

const INVALID_NAMESPACE = /[*?[\]\\\s]/;

function positive(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`[next-redis-cache] ${name} must be a positive number, got ${String(value)}`);
  }
  return value;
}

export function assertBuildId(buildId: string): string {
  if (!buildId || buildId.includes(":") || buildId.startsWith("_")) {
    throw new TypeError(
      `[next-redis-cache] invalid buildId "${buildId}": it must be non-empty, contain no ":" and not start with "_" (reserved)`,
    );
  }
  return buildId;
}

export function assertNamespace(namespace: unknown): string {
  if (typeof namespace !== "string" || namespace.length === 0 || INVALID_NAMESPACE.test(namespace)) {
    throw new TypeError(
      `[next-redis-cache] namespace must be a non-empty string without *?[]\\ or whitespace, got ${JSON.stringify(namespace)}`,
    );
  }
  return namespace;
}

export const isBuildPhase = (): boolean => process.env.NEXT_PHASE === "phase-production-build";

export function resolveConfig(config: RedisCacheConfig): ResolvedConfig {
  if (!config || typeof config !== "object") throw new TypeError("[next-redis-cache] config object is required");
  const namespace = assertNamespace(config.namespace);
  const buildId = config.buildId === undefined ? undefined : assertBuildId(config.buildId);
  const logger = resolveLogger(config.logger as Logger | false | undefined);
  const onEvent = config.onEvent;
  const emit = onEvent
    ? (event: CacheEvent) => {
        try {
          onEvent(event);
        } catch {
          // an observer must never break a cache operation
        }
      }
    : () => {};
  const disabled = config.disabled;
  const isDisabled =
    typeof disabled === "function" ? () => Boolean(disabled()) : disabled === undefined ? isBuildPhase : () => disabled;
  const fallback = config.fallback === false ? { buildOutput: false, reseed: false } : (config.fallback ?? {});
  const compression = config.compression ?? DEFAULT_COMPRESSION;
  if (!["none", "gzip", "brotli"].includes(compression)) {
    throw new TypeError(`[next-redis-cache] compression must be "none", "gzip" or "brotli", got ${JSON.stringify(compression)}`);
  }
  const onTagExpired = config.onTagExpired ?? "auto";
  if (onTagExpired !== "auto" && onTagExpired !== "stale" && onTagExpired !== "miss") {
    throw new TypeError(`[next-redis-cache] onTagExpired must be "auto", "stale" or "miss", got ${JSON.stringify(onTagExpired)}`);
  }
  const estimate = config.ttl?.estimateExpire;
  return {
    client: config.client,
    namespace,
    buildId,
    readMs: positive("timeouts.readMs", config.timeouts?.readMs, DEFAULT_READ_MS),
    writeMs: positive("timeouts.writeMs", config.timeouts?.writeMs, DEFAULT_WRITE_MS),
    openMs: config.circuitBreaker === false ? 0 : positive("circuitBreaker.openMs", config.circuitBreaker?.openMs, DEFAULT_OPEN_MS),
    buildOutput: fallback.buildOutput ?? true,
    reseed: fallback.reseed ?? true,
    staticSeconds: positive("ttl.staticSeconds", config.ttl?.staticSeconds, DEFAULT_STATIC_SECONDS),
    maxSeconds: positive("ttl.maxSeconds", config.ttl?.maxSeconds, DEFAULT_MAX_SECONDS),
    estimateExpire: estimate ?? ((s: number) => Math.floor(s * 1.5)),
    onTagExpired,
    compression,
    tagStateTtlSeconds: config.tagStateTtlSeconds === undefined ? 0 : positive("tagStateTtlSeconds", config.tagStateTtlSeconds, 0),
    logger,
    emit,
    isDisabled,
  };
}

/**
 * Build id resolution: explicit option, `BUILD_ID` env, `<distDir>/BUILD_ID` (the Next.js build output;
 * `distDir` defaults to `<cwd>/.next`, standalone servers chdir to their own directory). Returns
 * undefined when none is available.
 */
export function detectBuildId(explicit: string | undefined, distDir?: string): string | undefined {
  if (explicit) return explicit;
  const env = process.env.BUILD_ID?.trim();
  if (env) return env;
  const candidates = [distDir, path.join(process.cwd(), ".next")].filter((d): d is string => Boolean(d));
  for (const dir of candidates) {
    try {
      const id = readFileSync(path.join(dir, "BUILD_ID"), "utf8").trim();
      if (id) return id;
    } catch {
      // not a build output directory
    }
  }
  return undefined;
}

/**
 * Resolves the build id once (lazily, so a handler created at import time still sees the build
 * output). Without any build id the handlers use "default" and warn once.
 */
export function buildIdResolver(cfg: ResolvedConfig): (distDir?: string) => string {
  let resolved: string | undefined;
  return (distDir?: string) => {
    if (resolved) return resolved;
    const found = detectBuildId(cfg.buildId, distDir);
    if (found) {
      resolved = assertBuildId(found);
    } else {
      resolved = "default";
      cfg.logger.warn(
        "no buildId configured and no BUILD_ID found (env or .next/BUILD_ID); using \"default\" - entries of different builds will share keys",
      );
    }
    return resolved;
  };
}
