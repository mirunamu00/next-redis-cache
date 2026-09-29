// Chaos C11 / C12 - rolling update A -> B and rollback B -> A with startup cleanup (startCacheMaintenance)
// and prewarm (ROADMAP.md 7-9, A5). Kubernetes semantics: maxSurge 1, maxUnavailable 0 - old instances keep
// serving until replaced. 1.x deleted the old build's keys at startup and a miss became a 404; in 2.x the
// previous build is kept (TTL capped) and every prerendered page has an answer from the build output anyway.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@redis/client";
import { waitFor } from "../support/wait-for";
import { directRedisUrl, launch, traffic, type Fleet } from "./harness";

const DOCS = ["/about", "/docs/guide/doc-0", "/docs/reference/doc-1", "/docs/tutorial/doc-2", "/docs/ops/doc-3", "/docs/api/section-1/doc-4", "/docs/concepts/doc-5"];

let fleet: Fleet;
let admin: ReturnType<typeof createClient>;

beforeAll(async () => {
  fleet = await launch("static-site", { builds: ["A"], instances: 2, env: { NRC_PREWARM: "1", NRC_CLEANUP: "1" } });
  admin = createClient({ url: directRedisUrl });
  admin.on("error", () => {});
  await admin.connect();
});

afterAll(async () => {
  await fleet?.stop();
  admin?.destroy();
});

async function rollTo(build: string) {
  const load = traffic(fleet, DOCS);
  await fleet.rolling(build);
  const result = await load.stop();
  return { result, builds: fleet.instances.map((m) => m.build) };
}

/** Waits until every current instance reports a finished cleanup; returns the results. */
async function cleanups() {
  return waitFor(
    async () => {
      const all = (await fleet.stats()) as Array<{ maintenance: { maintenance?: { cleanup?: { gaveUp: boolean; value?: { kept: string[] } } } } }>;
      const results = all.map((s) => s.maintenance.maintenance?.cleanup);
      return results.every((r) => r && !r.gaveUp) ? results : undefined;
    },
    { timeout: 15_000, message: "cleanup finished on every instance" },
  );
}

const ttlOf = (key: string) => admin.ttl(key);

describe("rolling updates with startup cleanup", () => {
  it("[7-9] C11 rolling A -> B: old instances keep answering 200 while they drain (I1)", async () => {
    const { result, builds } = await rollTo("B");
    expect(builds).toEqual(["B", "B"]);
    expect(result.failures).toEqual([]);
  });

  it("[7-9] C11 after the rollout the previous build A is kept with a TTL cap, B is current and untouched", async () => {
    const results = await cleanups();
    for (const r of results) expect(r!.value!.kept.sort()).toEqual(["A", "B"]);
    expect(await admin.zRange(`${fleet.namespace}:_builds`, 0, -1)).toEqual(["A", "B"]);
    expect(await ttlOf(`${fleet.namespace}:A:e:/about`)).toBeLessThanOrEqual(24 * 3600);
    expect(await ttlOf(`${fleet.namespace}:B:e:/about`)).toBeGreaterThan(24 * 3600);
  });

  it("[7-9] C12 rollback B -> A: every response stays 200 (I1)", async () => {
    const { result, builds } = await rollTo("A");
    expect(builds).toEqual(["A", "A"]);
    expect(result.failures).toEqual([]);
  });

  it("[7-9] C12 after the rollback A is current again and B is the previous build", async () => {
    const results = await cleanups();
    for (const r of results) expect(r!.value!.kept.sort()).toEqual(["A", "B"]);
    const registry = await admin.zRange(`${fleet.namespace}:_builds`, 0, -1);
    expect(registry.at(-1)).toBe("A");
    expect(fleet.crashed).toEqual([]);
  });
});
