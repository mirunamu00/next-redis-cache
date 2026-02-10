const MAX_STORE_ENTRIES = 200;

// Use globalThis to share the store across module instances.
// Cache handlers load this file via raw Node.js import,
// while API routes load a Turbopack-bundled copy — different instances.
// globalThis ensures they share the same Map.
if (!globalThis.__cacheStore) {
  globalThis.__cacheStore = new Map();
}

/** @type {Map<string, { key: string, handler: string, value: unknown, size: number, ttl: number, tags: string[], storedAt: string }>} */
const cacheStore = globalThis.__cacheStore;

/**
 * Store a cache entry (called by cache handlers on set).
 * @param {string} handler - "legacy" | "use-cache"
 * @param {string} key
 * @param {unknown} value
 * @param {{ ttl?: number, tags?: string[] }} [meta]
 */
export function storeCacheEntry(handler, key, value, meta = {}) {
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  let serialized;
  try {
    serialized = JSON.stringify(value) ?? "null";
  } catch {
    serialized = String(value ?? "");
  }

  cacheStore.set(key, {
    key,
    handler,
    value: value ?? null,
    size: Buffer.byteLength(serialized || "", "utf8"),
    ttl: meta.ttl ?? -1,
    tags: meta.tags ?? [],
    storedAt: new Date().toISOString(),
  });

  if (cacheStore.size > MAX_STORE_ENTRIES) {
    const firstKey = cacheStore.keys().next().value;
    cacheStore.delete(firstKey);
  }
}

/**
 * Get all stored cache entries (without value, for listing).
 * @returns {Array<{ key: string, handler: string, size: number, ttl: number, tags: string[], storedAt: string }>}
 */
export function getCacheStore() {
  return Array.from(cacheStore.values()).map(({ value, ...rest }) => rest);
}

/**
 * Get a single cache entry with full value.
 * @param {string} key
 */
export function getCacheEntry(key) {
  return cacheStore.get(key);
}

/** Clear the entire cache store. */
export function clearCacheStore() {
  cacheStore.clear();
}
