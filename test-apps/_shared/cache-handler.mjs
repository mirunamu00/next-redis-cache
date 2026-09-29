// Legacy cache handler for the test apps (next.config `cacheHandler`).
//
// NRC_API=v2 (default) is the 2.x README wiring: createCacheHandler(config) with connectRedis as the
// client. NRC_API=v1 wires a 1.x package exactly the way the 1.x README (Quick Start, Step 1) did: the
// onCreation hook awaits client.connect() - kept for baselines against npm 1.x (ROADMAP.md D3).
// Operation counters are added by subclassing, without changing behavior.
import { assertApi, isBuildPhase, redisUrl, v1KeyPrefix, v2Config } from "./config.mjs";
import { count, observeClient, recordError } from "./test-hooks.mjs";

let Base;

if (assertApi() === "v1") {
  const { LegacyCacheHandler } = await import("@mirunamu/next-redis-cache");
  if (typeof LegacyCacheHandler !== "function") throw new Error("NRC_API=v1 needs a 1.x package (--pkg npm:1.x)");

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
  Base = LegacyCacheHandler;
} else {
  const { createCacheHandler } = await import("@mirunamu/next-redis-cache");
  Base = createCacheHandler(await v2Config());
}

class InstrumentedCacheHandler extends Base {
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
}

export default InstrumentedCacheHandler;
