import type { RedisClientType } from "@redis/client";

export function assertClientReady(client: RedisClientType): void {
  if (!client.isReady) {
    throw new Error(
      "[cache-handler] Redis client is not ready. Connection may be lost."
    );
  }
}

/**
 * Rejects if `promise` does not settle within `ms`. The timer is cleared as soon as the promise
 * settles, and it never keeps the process alive on its own.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[cache-handler] Redis timeout (${ms}ms)`)),
      ms
    );
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
