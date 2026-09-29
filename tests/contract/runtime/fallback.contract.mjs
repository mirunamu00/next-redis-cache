// Contract (runtime): the build-output fallback loads the installed Next's internal FileSystemCache
// (next/dist/server/lib/incremental-cache/file-system-cache.js) and reads a prerendered page and a route
// handler. Run by scripts/contract-types.mjs inside .work/contract@<variant> (tarball install), so every
// supported Next version is checked. Exits non-zero on any mismatch.
//
//   node fallback.contract.mjs <serverDistDir of the next-build fixture>
import assert from "node:assert/strict";
import { createCacheHandler } from "@mirunamu/next-redis-cache";

const serverDistDir = process.argv[2];
assert.ok(serverDistDir, "usage: node fallback.contract.mjs <serverDistDir>");

const warnings = [];
const Handler = createCacheHandler({
  client: null,
  namespace: "contract",
  buildId: "b1",
  disabled: false,
  logger: { warn: (m) => warnings.push(m), info: () => {} },
});
const handler = new Handler({ serverDistDir, dev: false });

const page = await handler.get("/about", { kind: "APP_PAGE", isRoutePPREnabled: false, isFallback: false });
assert.equal(page?.value?.kind, "APP_PAGE", `APP_PAGE from the build output (warnings: ${warnings.join("; ")})`);
assert.match(page.value.html, /<html/);
assert.ok(Buffer.isBuffer(page.value.rscData), "rscData is a Buffer");
assert.deepEqual([...page.value.segmentData.keys()].sort(), ["/_full", "/_tree", "/about/__PAGE__"]);
assert.ok(page.lastModified > 0, "lastModified is the file time");

const route = await handler.get("/icon", { kind: "APP_ROUTE" });
assert.equal(route?.value?.kind, "APP_ROUTE");
assert.ok(Buffer.isBuffer(route.value.body));
assert.equal(route.value.headers["content-type"], "image/png");

const notFound = await handler.get("/_not-found", { kind: "APP_PAGE" });
assert.equal(notFound?.value?.status, 404);

assert.equal(await handler.get("/nope", { kind: "APP_PAGE" }), null);
assert.deepEqual(warnings, []);
console.log("[contract-runtime] build-output fallback OK");
