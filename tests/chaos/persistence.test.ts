// Chaos C8 - a production-like Redis (AOF everysec + RDB, volatile-lru) restarts under traffic
// (ROADMAP.md section 9 "AOF restart"). Requires `npm run infra:up -- prodlike`.
// Invariants: I1 every prerendered page answers 200 through the restart (build-output fallback),
// I2 no crash / unhandled rejection, I4 Redis hits resume, I5 the tag state survives the restart (the
// AOF is flushed on a graceful shutdown), so an invalidated page is not served as fresh afterwards.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@redis/client";
import { waitFor } from "../support/wait-for";
import { launch, sleep, traffic, unhandledTotal, type Fleet } from "./harness";

const PRODLIKE_URL = `redis://default:test@127.0.0.1:${process.env.NRC_PRODLIKE_PORT ?? "6390"}`;
const COMPOSE = fileURLToPath(new URL("../../docker/compose.yml", import.meta.url));
const DOCS = ["/about", "/docs/guide/doc-0", "/docs/reference/doc-1", "/docs/tutorial/doc-2", "/docs/ops/doc-3"];

let fleet: Fleet;
let admin: ReturnType<typeof createClient>;

async function events(): Promise<Record<string, number>> {
  const all = (await fleet.stats()) as Array<{ events: Record<string, number> }>;
  const sum: Record<string, number> = {};
  for (const s of all) for (const [k, v] of Object.entries(s.events)) sum[k] = (sum[k] ?? 0) + v;
  return sum;
}

beforeAll(async () => {
  admin = createClient({ url: PRODLIKE_URL, socket: { reconnectStrategy: () => 200 } });
  admin.on("error", () => {});
  await admin.connect();
  fleet = await launch("static-site", { instances: 2, redisUrl: PRODLIKE_URL });
  for (const p of DOCS) await (await fleet.request(p)).arrayBuffer();
  await waitFor(async () => ((await events()).reseed ?? 0) >= DOCS.length, { timeout: 10_000, message: "pages re-seeded" });
});

afterAll(async () => {
  await fleet?.stop();
  admin?.destroy();
});

describe("C8 Redis restarts with its AOF", () => {
  it("pages stay 200, the tag state survives, hits resume (I1, I2, I4, I5)", async () => {
    // invalidate /about more than a second before the restart (AOF everysec)
    const inv = await fleet.request("/about", { method: "GET" });
    await inv.arrayBuffer();
    await admin.hSet(`${fleet.namespace}:_tagstate`, { "x:_N_T_/about": String(Date.now()) });
    await sleep(1500);
    const before = await unhandledTotal(fleet);

    const load = traffic(fleet, DOCS);
    await sleep(500);
    const restart = spawnSync("docker", ["compose", "-f", COMPOSE, "--profile", "prodlike", "restart", "prodlike"], { encoding: "utf8" });
    expect(restart.status, restart.stderr).toBe(0);
    await waitFor(async () => (await admin.ping()) === "PONG", { timeout: 30_000, message: "prodlike is back" });
    const hits = (await events()).hit ?? 0;
    await waitFor(async () => ((await events()).hit ?? 0) > hits + 5, { timeout: 20_000, message: "Redis hits resume (I4)" });
    const result = await load.stop();

    expect(result.failures).toEqual([]);
    expect(await admin.hGet(`${fleet.namespace}:_tagstate`, "x:_N_T_/about")).not.toBeNull();
    const page = await fleet.request("/about");
    await page.arrayBuffer();
    expect(page.status).toBe(200);
    expect((await unhandledTotal(fleet)) - before).toBe(0);
    expect(fleet.crashed).toEqual([]);
  });
});
