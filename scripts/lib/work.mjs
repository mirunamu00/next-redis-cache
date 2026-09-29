// Paths and small filesystem helpers shared by the test-environment scripts
// (pack, prepare-app, fleet, contract-types, perf). Everything is assembled under .work/ and
// .artifacts/ (both git-ignored). Directory names stay short because of the Windows path limit.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const WORK_DIR = path.join(REPO_ROOT, ".work");
export const ARTIFACTS_DIR = path.join(REPO_ROOT, ".artifacts");
export const TEST_APPS_DIR = path.join(REPO_ROOT, "test-apps");

export const APPS = ["static-site", "full-legacy", "full-cc"];
export const VARIANTS = ["next-16.1", "next-16.3", "canary"];
export const DEFAULT_VARIANT = "next-16.3";

/** .work/<app>@<variant> */
export const appWorkDir = (app, variant = DEFAULT_VARIANT) => path.join(WORK_DIR, `${app}@${variant}`);

/** .work/<app>@<variant>/builds/<buildId>: a standalone server ready for `node server.js`. */
export const buildDir = (app, variant, buildId) => path.join(appWorkDir(app, variant), "builds", buildId);

export function assertApp(app) {
  if (!APPS.includes(app)) throw new Error(`unknown app "${app}" (known: ${APPS.join(", ")})`);
}

export function assertVariant(variant) {
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant "${variant}" (known: ${VARIANTS.join(", ")})`);
}

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/** rm -rf with retries (Windows keeps handles open briefly after a process exits). */
export function rmrf(target) {
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

export function copyDir(from, to) {
  cpSync(from, to, { recursive: true, force: true });
}

export const exists = existsSync;
