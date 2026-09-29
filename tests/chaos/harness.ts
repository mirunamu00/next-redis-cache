/**
 * Chaos harness (ROADMAP.md section 6.5): fleets of standalone test-app builds, Redis through a
 * per-worker toxiproxy proxy, background traffic and invariant checks.
 *
 * Prerequisites: `npm run infra:up -- redis84 toxiproxy prodlike` (prodlike: C7, C8) and the builds
 *   node scripts/prepare-app.mjs static-site --build A,B
 *   node scripts/prepare-app.mjs full-legacy --build A
 *   node scripts/prepare-app.mjs full-cc --build A
 *
 * Invariants: I1 no 404/5xx on prerendered paths, I2 no crash and no unhandledRejection,
 * I3 bounded latency, I4 hits resume within 10s of recovery, I5 no old data served as fresh after an
 * invalidation (while Redis is healthy).
 */
import { startFleet } from "../../scripts/fleet.mjs";
import { ToxiproxyClient, type ProxyHandle } from "../support/toxiproxy";

export type Fleet = Awaited<ReturnType<typeof startFleet>>;
export type FleetOptions = Parameters<typeof startFleet>[0];

export const variant = process.env.NRC_NEXT_VARIANT ?? "next-16.3";
export const directRedisUrl = `redis://default:test@127.0.0.1:${process.env.NRC_REDIS84_PORT ?? "6384"}`;

let seq = 0;
export const chaosNamespace = (label: string) => `chaos_${label}_${process.pid}_${++seq}`;

export function launch(app: string, options: Partial<FleetOptions> = {}): Promise<Fleet> {
  return startFleet({ app, variant, instances: 2, builds: ["A"], namespace: chaosNamespace(app.replace(/-/g, "_")), ...options });
}

/** This worker's toxiproxy proxy in front of redis84. */
export async function redisProxy(): Promise<ProxyHandle> {
  const proxy = await new ToxiproxyClient().workerProxy("redis84:6379");
  await proxy.clear();
  return proxy;
}

export interface TrafficResult {
  requests: number;
  statuses: Record<string, number>;
  /** Non-200 responses and network errors, first 20. */
  failures: string[];
  maxLatencyMs: number;
}

/**
 * Sends GET requests round-robin over `paths` with `concurrency` loops until stopped.
 * Every response body is drained so connections are reused.
 */
export function traffic(fleet: Fleet, paths: string[], { concurrency = 4, timeoutMs = 15_000 } = {}) {
  let running = true;
  let i = 0;
  const result: TrafficResult = { requests: 0, statuses: {}, failures: [], maxLatencyMs: 0 };
  const loop = async () => {
    while (running) {
      const p = paths[i++ % paths.length]!;
      const t0 = performance.now();
      try {
        const res = await fleet.request(p, { signal: AbortSignal.timeout(timeoutMs) });
        await res.arrayBuffer();
        result.statuses[res.status] = (result.statuses[res.status] ?? 0) + 1;
        if (res.status !== 200 && result.failures.length < 20) result.failures.push(`${res.status} ${p}`);
      } catch (err) {
        result.statuses.error = (result.statuses.error ?? 0) + 1;
        if (result.failures.length < 20) result.failures.push(`error ${p}: ${(err as Error).message}`);
      }
      result.requests += 1;
      result.maxLatencyMs = Math.max(result.maxLatencyMs, performance.now() - t0);
    }
  };
  const loops = Array.from({ length: concurrency }, loop);
  return {
    result,
    async stop(): Promise<TrafficResult> {
      running = false;
      await Promise.all(loops);
      return result;
    },
  };
}

export async function unhandledTotal(fleet: Fleet): Promise<number> {
  const all = (await fleet.stats()) as Array<{ unhandledRejections: number }>;
  return all.reduce((n, s) => n + s.unhandledRejections, 0);
}

/** First response of `path` with its latency; never throws (a hang shows up as a timeout). */
export async function timedGet(fleet: Fleet, path: string, timeoutMs: number) {
  const t0 = performance.now();
  try {
    const res = await fleet.request(path, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    return { status: res.status, ms: performance.now() - t0, body };
  } catch (err) {
    return { status: 0, ms: performance.now() - t0, body: "", error: (err as Error).message };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
