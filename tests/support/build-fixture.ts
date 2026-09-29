/**
 * Copies of the next-build fixture (part of a Next 16.3.6 static-site build) for tests that read build
 * output: every file gets a fixed past time, so "invalidated after the build" never depends on how fast
 * the machine is. The tag checks compare invalidation times with the file time strictly (Next's
 * areTagsExpired: `expired > timestamp`); a copy written in the same millisecond as an invalidation made a
 * test flaky (CI run 36544312834, unit Node 24: "expected 1790671317671 to be -1").
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_DIST = fileURLToPath(new URL("../fixtures/next-build/.next/", import.meta.url));

/** File time of every file in a copy. */
export const BUILD_TIME = new Date("2026-01-01T00:00:00Z");

export type PrerenderManifestShape = {
  routes: Record<string, { srcRoute?: string; initialRevalidateSeconds?: number | false }>;
  dynamicRoutes?: Record<string, { fallback: false | null | string }>;
};

export interface BuildCopy {
  /** The copy's `.next` directory. */
  distDir: string;
  /** The copy's `.next/server` directory (Next's serverDistDir). */
  serverDistDir: string;
  cleanup(): void;
}

/** Copies the fixture build output (optionally editing files first) with every file at BUILD_TIME. */
export function buildCopy(edit?: { manifest?: (manifest: PrerenderManifestShape) => void; files?: (distDir: string) => void }): BuildCopy {
  const root = mkdtempSync(path.join(tmpdir(), "nrc-bo-"));
  cpSync(FIXTURE_DIST, root, { recursive: true });
  if (edit?.manifest) {
    const file = path.join(root, "prerender-manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as PrerenderManifestShape;
    edit.manifest(manifest);
    writeFileSync(file, JSON.stringify(manifest));
  }
  edit?.files?.(root);
  const touch = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) touch(p);
      else utimesSync(p, BUILD_TIME, BUILD_TIME);
    }
  };
  touch(root);
  return { distDir: root, serverDistDir: path.join(root, "server"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
