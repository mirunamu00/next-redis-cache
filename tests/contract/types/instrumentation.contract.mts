// Contract (types): the instrumentation entry point.
import { cleanupOldBuildKeys } from "@mirunamu/next-redis-cache/instrumentation";

export async function contract(): Promise<void> {
  // deprecated 1.x cleanup, still available in 2.x
  const { deleted } = await cleanupOldBuildKeys({ redisUrl: "redis://127.0.0.1:6379", patterns: [{ scan: "app:*", keepPrefix: "app:b1:" }], timeoutMs: 2000 });
  void deleted;
}
