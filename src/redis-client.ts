import type { RedisClientType } from "@redis/client";

export function assertClientReady(client: RedisClientType): void {
  if (!client.isReady) {
    throw new Error(
      "[cache-handler] Redis client is not ready. Connection may be lost."
    );
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[cache-handler] Redis timeout (${ms}ms)`)), ms)
    ),
  ]);
}
