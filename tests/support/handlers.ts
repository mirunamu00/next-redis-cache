/**
 * Helpers to drive the package's handlers directly (unit, fault, integration, contract layers).
 * 2.x handlers keep their state in the factory closure, so every call creates an isolated handler.
 */
import { createCacheHandler } from "../../src/legacy-handler";
import { createUseCacheHandler } from "../../src/use-cache-handler";
import type { RedisCacheConfig, UseCacheConfig } from "../../src/types";
import { uniqueNamespace } from "./namespace";

/** Context Next passes to the legacy handler constructor. */
export const legacyContext = (serverDistDir?: string) => ({ revalidatedTags: [] as string[], _requestHeaders: {}, serverDistDir });

type TestConfig<C> = Omit<C, "namespace"> & { namespace?: string };

/** Defaults for tests: unique namespace, fixed build id, fallback off, enabled even if NEXT_PHASE leaks in. */
export function testConfig<C extends RedisCacheConfig>(config: TestConfig<C>): C {
  return { namespace: uniqueNamespace(), buildId: "b1", fallback: false, disabled: false, ...config } as C;
}

/** A legacy handler instance (a new class per call: nothing is shared between tests). */
export function legacyHandler(config: TestConfig<RedisCacheConfig>, serverDistDir?: string) {
  const cfg = testConfig(config);
  const Handler = createCacheHandler(cfg);
  return { Handler, handler: new Handler(legacyContext(serverDistDir)), config: cfg };
}

export function useCacheHandler(config: TestConfig<UseCacheConfig>) {
  const cfg = testConfig<UseCacheConfig>(config);
  return { handler: createUseCacheHandler(cfg), config: cfg };
}

export interface UseCacheEntryInput {
  value?: string;
  tags?: string[];
  timestamp?: number;
  revalidate?: number;
  expire?: number;
  stale?: number;
}

/** A use-cache entry as Next hands it to `set` (value is a stream). */
export function useCacheEntry({ value = "v", tags = [], timestamp = Date.now(), revalidate = 3600, expire = 86400, stale = 300 }: UseCacheEntryInput = {}) {
  return {
    value: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(value));
        c.close();
      },
    }),
    tags,
    timestamp,
    revalidate,
    expire,
    stale,
  };
}

/** Drains an entry's stream into a string. */
export async function readEntry(entry: { value: ReadableStream<Uint8Array> } | undefined): Promise<string | undefined> {
  if (!entry) return undefined;
  return new Response(entry.value).text();
}

/** An APP_PAGE value like Next's IncrementalCache hands it to the legacy `set`. */
export function appPageValue(html = "<html>page</html>", tags: string[] = []) {
  return {
    kind: "APP_PAGE",
    html,
    rscData: Buffer.from("rsc"),
    headers: { "x-next-cache-tags": tags.join(",") },
    postponed: undefined,
    status: 200,
    segmentData: new Map([["/_tree", Buffer.from("tree")]]),
  };
}

/** An APP_ROUTE value (route handler response). */
export function appRouteValue(body = "{}", headers: Record<string, string> = {}) {
  return { kind: "APP_ROUTE", body: Buffer.from(body), status: 200, headers };
}

/** A FETCH value (data cache entry). */
export function fetchValue(body = "{}", revalidate = 60) {
  return {
    kind: "FETCH",
    data: { headers: {}, body: Buffer.from(body).toString("base64"), status: 200, url: "http://origin/x" },
    revalidate,
  };
}
