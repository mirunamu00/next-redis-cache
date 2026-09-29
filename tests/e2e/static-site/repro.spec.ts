// Known-bug reproductions on static-site (ROADMAP.md 7-4, A2). Expected failures on 1.0.6.
import { expect, getPage, launchFleet, repro, segmentPrefetch, test } from "../fixtures";

test.describe("static-site reproductions", () => {
  test("[7-4] segment prefetch of a prewarmed page answers 200", async ({ fleet }) => {
    repro("7-4", "prewarm stores segment keys without the leading slash, so Next finds no segment");
    for (const p of ["/about", "/docs/guide/doc-6"]) {
      expect((await getPage(fleet, p)).status, p).toBe(200);
      expect((await segmentPrefetch(fleet, p, "/_tree")).status, `${p} /_tree`).toBe(200);
    }
  });

  test("[A2] prerendered docs pages answer 200 on an empty Redis (no prewarm)", async () => {
    repro("A2", "a cache miss on a dynamicParams=false page becomes a 404 without a build-output fallback (P3)");
    const fleet = await launchFleet("static-site", { instances: 1, env: { NRC_PREWARM: "0" } });
    try {
      for (const p of ["/docs/guide/doc-0", "/docs/api/section-1/doc-4"]) expect((await getPage(fleet, p)).status, p).toBe(200);
    } finally {
      await fleet.stop();
    }
  });
});
