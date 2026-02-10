import type { RedisClientType } from "@redis/client";

export interface RedisHandlerOptions {
  client: RedisClientType;
  keyPrefix?: string;
  sharedTagsKey?: string;
  sharedTagsTtlKey?: string;
  revalidatedTagsKey?: string;
  timeoutMs?: number;
}

export interface ResolvedRedisOptions {
  client: RedisClientType;
  keyPrefix: string;
  sharedTagsKey: string;
  sharedTagsTtlKey: string;
  revalidatedTagsKey: string;
  timeoutMs: number;
}

export function resolveOptions(opts: RedisHandlerOptions): ResolvedRedisOptions {
  return {
    client: opts.client,
    keyPrefix: opts.keyPrefix ?? "",
    sharedTagsKey: opts.sharedTagsKey ?? "__sharedTags__",
    sharedTagsTtlKey: opts.sharedTagsTtlKey ?? "__sharedTagsTtl__",
    revalidatedTagsKey: opts.revalidatedTagsKey ?? "__revalidated_tags__",
    timeoutMs: opts.timeoutMs ?? 5000,
  };
}

/** Next.js implicit tag prefix */
export const NEXT_CACHE_IMPLICIT_TAG_ID = "_N_T_";

export function isImplicitTag(tag: string): boolean {
  return tag.startsWith(NEXT_CACHE_IMPLICIT_TAG_ID);
}

// ── Types moved from legacy-handler.ts ──────────────────────────────

export interface LegacyHandlerConfig {
  client: RedisClientType;
  keyPrefix?: string;
  sharedTagsKey?: string;
  sharedTagsTtlKey?: string;
  revalidatedTagsKey?: string;
  timeoutMs?: number;
  defaultStaleAge?: number;
  estimateExpireAge?: (staleAge: number) => number;
}

export type OnCreationHook = (context: {
  serverDistDir?: string;
  dev?: boolean;
}) => Promise<LegacyHandlerConfig | null> | LegacyHandlerConfig | null;

// ── Types moved from use-cache-handler.ts ───────────────────────────

export interface UseCacheHandlerOptions extends RedisHandlerOptions {
  /**
   * Key prefix specific to use-cache entries (separate from legacy ISR cache).
   * Defaults to "uc:" prepended to the base keyPrefix.
   */
  useCacheKeyPrefix?: string;
}
