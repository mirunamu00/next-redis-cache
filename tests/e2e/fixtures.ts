/**
 * Playwright fixtures for the e2e layer: one fleet per project (worker scope), plus helpers that read
 * the test markers and the origin hit counters.
 *
 * Expected failures: a reproduction of a known bug (ROADMAP.md section 2) calls
 * `test.fail(true, "[7-x] ...")` as its first statement. Playwright then fails the run if the test
 * unexpectedly passes, so the fixing commit must remove the marker (same contract as vitest `it.fails`).
 */
import { test as base, expect, type APIResponse } from "@playwright/test";
import { createRequire } from "node:module";
import path from "node:path";
import { startFleet } from "../../scripts/fleet.mjs";
import { appWorkDir } from "../../scripts/lib/work.mjs";

export type Fleet = Awaited<ReturnType<typeof startFleet>>;
export type FleetOptions = Parameters<typeof startFleet>[0];

export const variant = process.env.NRC_NEXT_VARIANT ?? "next-16.3";

const REDIS_PORTS: Record<string, string> = {
  redis84: process.env.NRC_REDIS84_PORT ?? "6384",
  redis72: process.env.NRC_REDIS72_PORT ?? "6372",
};
const redisService = process.env.NRC_E2E_REDIS ?? "redis84";
export const e2eRedisUrl = `redis://default:test@127.0.0.1:${REDIS_PORTS[redisService] ?? REDIS_PORTS.redis84}`;

/**
 * Per-app defaults. static-site and full-legacy prewarm like the docs app does with 1.x: without it,
 * dynamicParams=false pages answer 404 on an empty Redis (covered separately as a reproduction).
 */
export const APP_DEFAULTS: Record<string, Partial<FleetOptions>> = {
  "static-site": { env: { NRC_PREWARM: "1" } },
  "full-legacy": { env: { NRC_PREWARM: "1" } },
  "full-cc": {},
};

let seq = 0;

/** Starts a fleet for `app` with the e2e defaults; callers must stop it. */
export function launchFleet(app: string, options: Partial<FleetOptions> = {}): Promise<Fleet> {
  const defaults = APP_DEFAULTS[app] ?? {};
  return startFleet({
    app,
    variant,
    builds: ["A"],
    instances: 2,
    redisUrl: e2eRedisUrl,
    namespace: `e2e_${app.replace(/-/g, "_")}_${process.pid}_${++seq}`,
    ...defaults,
    ...options,
    env: { ...(defaults.env ?? {}), ...(options.env ?? {}) },
  });
}

export const test = base.extend<object, { fleet: Fleet }>({
  fleet: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      const fleet = await launchFleet(workerInfo.project.name);
      await use(fleet);
      await fleet.stop();
      expect(fleet.crashed.map((m) => m.id), "instances that exited on their own").toEqual([]);
    },
    { scope: "worker", timeout: 180_000 },
  ],
  baseURL: async ({ fleet }, use) => {
    await use(fleet.url);
  },
});

export { expect };

export interface Markers {
  build?: string;
  renderId?: string;
  renderedAt?: number;
  instance?: string;
  version?: number;
}

/** Reads the first test marker and data-version from an HTML body. */
export function markers(html: string): Markers {
  const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];
  const version = attr("data-version");
  const renderedAt = attr("data-rendered-at");
  return {
    build: attr("data-build"),
    renderId: attr("data-render-id"),
    renderedAt: renderedAt ? Number(renderedAt) : undefined,
    instance: attr("data-instance"),
    version: version ? Number(version) : undefined,
  };
}

export async function getPage(fleet: Fleet, p: string, init?: RequestInit) {
  const res = await fleet.request(p, init);
  const body = await res.text();
  return { status: res.status, cache: res.headers.get("x-nextjs-cache"), upstream: res.headers.get("x-nrc-upstream"), body, ...markers(body) };
}

/** Paths listed in /sitemap.xml. */
export async function sitemapPaths(fleet: Fleet): Promise<string[]> {
  const xml = await (await fleet.request("/sitemap.xml")).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]!).pathname);
}

/**
 * Segment prefetch request exactly as the Next client sends it (RSC + prefetch headers and the `_rsc`
 * cache-busting parameter computed with the variant's own Next code).
 */
export async function segmentPrefetch(fleet: Fleet, pagePath: string, segment: string) {
  const req = createRequire(path.join(appWorkDir(fleet.app, fleet.variant), "package.json"));
  const { computeCacheBustingSearchParam } = req("next/dist/shared/lib/router/utils/cache-busting-search-param.js");
  const rsc = await computeCacheBustingSearchParam("1", segment, undefined, undefined);
  const sep = pagePath.includes("?") ? "&" : "?";
  const res = await fleet.request(`${pagePath}${sep}_rsc=${rsc}`, {
    headers: { RSC: "1", "Next-Router-Prefetch": "1", "Next-Router-Segment-Prefetch": segment },
  });
  return { status: res.status, length: (await res.arrayBuffer()).byteLength };
}

export async function unhandledTotal(fleet: Fleet): Promise<number> {
  const all = await fleet.stats();
  return (all as Array<{ unhandledRejections: number }>).reduce((n, s) => n + s.unhandledRejections, 0);
}

export type { APIResponse };
