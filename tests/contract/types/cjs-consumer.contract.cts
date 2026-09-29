// Contract (types): a CommonJS consumer resolves every entry point through the "require" condition to
// the .d.cts declarations.
import { createCacheHandler } from "@mirunamu/next-redis-cache";
import { createUseCacheHandler } from "@mirunamu/next-redis-cache/use-cache";
import { connectRedis } from "@mirunamu/next-redis-cache/redis";
import { cleanupOldBuildKeys } from "@mirunamu/next-redis-cache/instrumentation";

export async function contract(): Promise<void> {
  const config = { client: () => connectRedis(process.env.REDIS_URL, { waitMs: 500 }), namespace: "app" };
  const Handler = createCacheHandler(config);
  await new Handler({}).get("/about", { kind: "APP_PAGE" });
  const handler = createUseCacheHandler(config);
  await handler.updateTags(["t"], { expire: 60 });
  const { deleted } = await cleanupOldBuildKeys({ redisUrl: "redis://127.0.0.1:6379", patterns: [{ scan: "app:*" }], timeoutMs: 2000 });
  void deleted;
}
