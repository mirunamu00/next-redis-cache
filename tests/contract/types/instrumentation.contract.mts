// Contract (types): the instrumentation entry point.
import { cleanupOldBuildKeys, prewarmFromBuildOutput, type PrewarmResult } from "@mirunamu/next-redis-cache/instrumentation";
import type { RedisCacheConfig } from "@mirunamu/next-redis-cache";

declare const config: RedisCacheConfig;

export async function contract(): Promise<void> {
  const result: PrewarmResult = await prewarmFromBuildOutput(config, { concurrency: 4, distDir: ".next" });
  void [result.prewarmed, result.skipped, result.failed, result.unavailable];
  // deprecated 1.x cleanup, still available in 2.x
  const { deleted } = await cleanupOldBuildKeys({ redisUrl: "redis://127.0.0.1:6379", patterns: [{ scan: "app:*", keepPrefix: "app:b1:" }], timeoutMs: 2000 });
  void deleted;
}
