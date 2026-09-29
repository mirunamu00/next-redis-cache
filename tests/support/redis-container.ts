/**
 * Redis containers for the integration layer (testcontainers).
 *
 * Each test file starts its own containers (self-contained, random host ports) and stops them in
 * afterAll; testcontainers' reaper removes leftovers if the process dies. Which versions run is
 * decided by redisVersionsUnderTest() (NRC_REDIS_VERSIONS).
 */
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { redisUrl, TEST_PASSWORD } from "./redis";

export { redisVersionsUnderTest, SUPPORTED_REDIS_VERSIONS } from "./redis-versions";

export interface RedisServer {
  version: string;
  host: string;
  port: number;
  url: string;
  container: StartedTestContainer;
  stop(): Promise<void>;
}

export async function startRedisContainer(version: string): Promise<RedisServer> {
  const container = await new GenericContainer(`redis:${version}`)
    .withCommand(["redis-server", "--requirepass", TEST_PASSWORD, "--save", "", "--appendonly", "no"])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .withStartupTimeout(120_000)
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(6379);
  return {
    version,
    host,
    port,
    url: redisUrl(host, port),
    container,
    stop: async () => {
      await container.stop();
    },
  };
}
