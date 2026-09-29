// Contract (types): the instrumentation entry point.
import {
  cleanupOldBuildKeys,
  cleanupOldBuilds,
  prewarmFromBuildOutput,
  startCacheMaintenance,
  type CleanupResult,
  type MaintenanceResult,
  type PrewarmResult,
} from "@mirunamu/next-redis-cache/instrumentation";
import type { RedisCacheConfig } from "@mirunamu/next-redis-cache";
import type { RedisClientType } from "@redis/client";

declare const config: RedisCacheConfig;
declare const client: RedisClientType;

export async function contract(): Promise<void> {
  const { done } = startCacheMaintenance({ config, cleanup: { keepPrevious: 1, minIdleSeconds: 1800, retiredTtlSeconds: 86400, attempts: 10 }, prewarm: { concurrency: 4 } });
  const maintenance: MaintenanceResult = await done;
  if (maintenance.cleanup && !maintenance.cleanup.gaveUp) void maintenance.cleanup.value.removedBuilds;
  startCacheMaintenance({ config, cleanup: false, prewarm: true });
  const cleaned: CleanupResult = await cleanupOldBuilds(client, { namespace: "app", buildId: "b1" });
  const prewarmed: PrewarmResult = await prewarmFromBuildOutput(config, { concurrency: 4, distDir: ".next" });
  // deprecated 1.x cleanup, still available in 2.x
  const { deleted } = await cleanupOldBuildKeys({ redisUrl: "redis://127.0.0.1:6379", patterns: [{ scan: "app:*", keepPrefix: "app:b1:" }], timeoutMs: 2000 });
  void [cleaned.deleted, prewarmed.prewarmed, deleted];
}
