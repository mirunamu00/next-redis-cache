// Contract (types): a CommonJS consumer resolves every entry point through the "require" condition to
// the .d.cts declarations (conditional types since 1.1.0; before, require got the ESM .d.ts).
import { LegacyCacheHandler } from "@mirunamu/next-redis-cache";
import { createUseCacheHandler } from "@mirunamu/next-redis-cache/use-cache";
import { cleanupOldBuildKeys, registerInitialCache } from "@mirunamu/next-redis-cache/instrumentation";
import type { RedisClientType } from "@redis/client";

export async function contract(client: RedisClientType): Promise<void> {
  LegacyCacheHandler.onCreation(() => ({ client, keyPrefix: "app:b1:" }));
  const handler = createUseCacheHandler({ client, keyPrefix: "app:b1:" });
  await handler.updateTags(["t"], { expire: 60 });
  const { prewarmed } = await registerInitialCache(LegacyCacheHandler);
  const { deleted } = await cleanupOldBuildKeys({ redisUrl: "redis://127.0.0.1:6379", patterns: [{ scan: "app:*" }], timeoutMs: 2000 });
  void [prewarmed, deleted];
}
