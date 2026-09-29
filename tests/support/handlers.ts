/**
 * Helpers to drive the package's handlers directly (unit, fault, integration, contract layers).
 *
 * LegacyCacheHandler keeps its configuration in static fields, so every test gets a fresh copy of
 * the module (vi.resetModules + dynamic import) and never sees another test's configuration.
 */
import { vi } from "vitest";
import type { LegacyHandlerConfig, OnCreationHook } from "../../src/types";

type LegacyModule = typeof import("../../src/legacy-handler");
export type LegacyHandlerClass = LegacyModule["LegacyCacheHandler"];
export type LegacyHandler = InstanceType<LegacyHandlerClass>;

/** Context Next passes to the legacy handler constructor (only the fields 1.x reads). */
export const legacyContext = () => ({ revalidatedTags: [] as string[], _requestHeaders: {} });

/** A fresh LegacyCacheHandler class with `hook` registered, plus one instance. */
export async function freshLegacy(hook: OnCreationHook | LegacyHandlerConfig): Promise<{ Handler: LegacyHandlerClass; handler: LegacyHandler }> {
  vi.resetModules();
  const { LegacyCacheHandler } = (await import("../../src/legacy-handler")) as LegacyModule;
  LegacyCacheHandler.onCreation(typeof hook === "function" ? hook : () => hook);
  return { Handler: LegacyCacheHandler, handler: new LegacyCacheHandler(legacyContext()) };
}

/** A fresh instrumentation module (registerInitialCache / cleanupOldBuildKeys). */
export async function freshInstrumentation() {
  vi.resetModules();
  return import("../../src/instrumentation");
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

/** A FETCH value (data cache entry). */
export function fetchValue(body = "{}", tags: string[] = [], revalidate = 60) {
  return {
    kind: "FETCH",
    data: { headers: {}, body: Buffer.from(body).toString("base64"), status: 200, url: "http://origin/x" },
    tags,
    revalidate,
  };
}
