// Chaos C11 / C12 - rolling update A -> B and rollback B -> A with the README's startup cleanup
// (cleanupOldBuildKeys keepPrefix = own build) and prewarm, like the docs app on 1.x (ROADMAP.md 7-9).
// Kubernetes semantics: maxSurge 1, maxUnavailable 0 - old instances keep serving until replaced.
import { afterAll, beforeAll, describe, expect } from "vitest";
import { itRepro } from "../support/repro";
import { launch, traffic, type Fleet } from "./harness";

const DOCS = ["/about", "/docs/guide/doc-0", "/docs/reference/doc-1", "/docs/tutorial/doc-2", "/docs/ops/doc-3", "/docs/api/section-1/doc-4", "/docs/concepts/doc-5"];

let fleet: Fleet;

beforeAll(async () => {
  fleet = await launch("static-site", { builds: ["A"], instances: 2, env: { NRC_PREWARM: "1", NRC_CLEANUP: "1" } });
});

afterAll(async () => {
  await fleet?.stop();
});

async function rollTo(build: string) {
  const load = traffic(fleet, DOCS);
  await fleet.rolling(build);
  const result = await load.stop();
  return { result, builds: fleet.instances.map((m) => m.build) };
}

describe("rolling updates with startup cleanup", () => {
  itRepro("7-9", "C11 rolling A -> B: old instances keep answering 200 while they drain (I1)", async () => {
    const { result, builds } = await rollTo("B");
    expect(builds).toEqual(["B", "B"]);
    expect(result.failures).toEqual([]);
  });

  itRepro("7-9", "C12 rollback B -> A: every response stays 200 (I1)", async () => {
    const { result, builds } = await rollTo("A");
    expect(builds).toEqual(["A", "A"]);
    expect(result.failures).toEqual([]);
  });
});
