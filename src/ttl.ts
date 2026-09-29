/**
 * TTL policy (ROADMAP.md section 5.2, issue 7-11): counted from the write, never from lastModified,
 * so re-seeding an entry built days ago still stores it.
 *   numeric revalidate  -> estimateExpire(revalidate)   (default revalidate * 1.5)
 *   otherwise           -> staticSeconds                (default 30 days)
 * Every TTL is capped at maxSeconds (default 365 days) and is at least 1 second.
 */
import type { ResolvedConfig } from "./config";

export function ttlSeconds(cfg: Pick<ResolvedConfig, "estimateExpire" | "staticSeconds" | "maxSeconds">, revalidate: unknown): number {
  let base = typeof revalidate === "number" && revalidate > 0 ? cfg.estimateExpire(revalidate) : cfg.staticSeconds;
  if (!Number.isFinite(base)) base = cfg.staticSeconds;
  return Math.max(1, Math.min(Math.floor(base), Math.floor(cfg.maxSeconds)));
}

/** SET options for an entry with `ttl` seconds (optionally only if the key does not exist). */
export function setOptions(ttl: number, onlyIfAbsent = false) {
  return onlyIfAbsent
    ? ({ expiration: { type: "EX", value: ttl }, condition: "NX" } as const)
    : ({ expiration: { type: "EX", value: ttl } } as const);
}
