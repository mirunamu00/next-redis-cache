/**
 * Redis client factory for tests. Always uses the test-only dummy password; never point it at a real Redis.
 */
import { createClient } from "@redis/client";

/** Test-only dummy password used by docker/compose.yml and testcontainers. */
export const TEST_PASSWORD = "test";

function buildClient(url: string, database: number, reconnect: false | number, connectTimeout: number) {
  return createClient({
    url,
    database,
    socket: {
      connectTimeout,
      reconnectStrategy: reconnect === false ? false : () => reconnect,
    },
  });
}

export type TestRedisClient = ReturnType<typeof buildClient>;

export interface TestClientOptions {
  /** Logical database (default 0). */
  database?: number;
  /** false disables reconnects; a number is a fixed reconnect delay in ms (default 50). */
  reconnect?: false | number;
  /** Socket connect timeout in ms (default 2000). */
  connectTimeout?: number;
  /** Skip `connect()` (for tests that exercise the connection phase themselves). */
  lazy?: boolean;
}

export interface TrackedClient {
  client: TestRedisClient;
  /** Every "error" event emitted by the client, in order. */
  errors: Error[];
  /** Closes the client if it is still open; safe to call twice. */
  close(): void;
}

/**
 * Creates a client with an attached error listener (an unhandled "error" event would crash the test
 * process) and connects it unless `lazy` is set.
 */
export async function connectTestClient(url: string, options: TestClientOptions = {}): Promise<TrackedClient> {
  const { database = 0, reconnect = 50, connectTimeout = 2000, lazy = false } = options;
  const client = buildClient(url, database, reconnect, connectTimeout);
  const errors: Error[] = [];
  client.on("error", (err: Error) => errors.push(err));
  if (!lazy) await client.connect();
  return {
    client,
    errors,
    close() {
      if (client.isOpen) client.destroy();
    },
  };
}

/** Builds a redis:// URL with the test password. */
export function redisUrl(host: string, port: number): string {
  return `redis://default:${TEST_PASSWORD}@${host}:${port}`;
}
