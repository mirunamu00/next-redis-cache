// Legacy cache handler for the test apps (next.config `cacheHandler`).
//
// NRC_API=v1 wires the package exactly the way the 1.x README (Quick Start, Step 1) tells users to:
// the onCreation hook creates a client with default options and awaits client.connect(). Keeping the
// documented wiring is deliberate - the reproduction tests (ROADMAP.md 7-2) must observe what real
// users observe. Operation counters are added by subclassing, without changing behavior.
import { assertApi, isBuildPhase, redisUrl, v1KeyPrefix } from "./config.mjs";
import { count, observeClient, recordError } from "./test-hooks.mjs";

let Handler;

if (assertApi() === "v1") {
  const { LegacyCacheHandler } = await import("@mirunamu/next-redis-cache");

  LegacyCacheHandler.onCreation(async () => {
    if (isBuildPhase() || !redisUrl()) return null;
    const { createClient } = await import("@redis/client");
    const client = createClient({ url: redisUrl() });
    client.on("error", (err) => {
      recordError("legacy-client", err);
    });
    observeClient(client);
    await client.connect();
    return {
      client,
      keyPrefix: v1KeyPrefix(),
      sharedTagsKey: "_tags",
      sharedTagsTtlKey: "_tagTtls",
      revalidatedTagsKey: "_revalidated",
    };
  });

  Handler = class InstrumentedLegacyCacheHandler extends LegacyCacheHandler {
    async get(...args) {
      count("legacy", "get");
      const value = await super.get(...args);
      count("legacy", value ? "hit" : "miss");
      return value;
    }
    async set(...args) {
      count("legacy", "set");
      return super.set(...args);
    }
    async revalidateTag(...args) {
      count("legacy", "revalidateTag");
      return super.revalidateTag(...args);
    }
  };
} else {
  const mod = await import("@mirunamu/next-redis-cache");
  if (typeof mod.createCacheHandler !== "function") {
    throw new Error("NRC_API=v2 needs the 2.x factory API (createCacheHandler), which lands in P2");
  }
  // The v2 wiring is written together with the v2 API (P2).
  throw new Error("NRC_API=v2 adapter is not implemented yet");
}

export default Handler;
