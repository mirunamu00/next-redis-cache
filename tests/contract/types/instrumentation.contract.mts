// Contract (types): the instrumentation entry point keeps its 1.x call shapes.
import { cleanupOldBuildKeys, registerInitialCache } from "@mirunamu/next-redis-cache/instrumentation";
import { LegacyCacheHandler } from "@mirunamu/next-redis-cache";

export async function contract(): Promise<void> {
  const { prewarmed } = await registerInitialCache(LegacyCacheHandler, { setOnlyIfNotExists: true });
  const { deleted } = await cleanupOldBuildKeys({ redisUrl: "redis://127.0.0.1:6379", patterns: [{ scan: "app:*", keepPrefix: "app:b1:" }] });
  void [prewarmed, deleted];
}
