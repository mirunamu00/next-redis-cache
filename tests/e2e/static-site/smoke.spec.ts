import { expect, getPage, segmentPrefetch, sitemapPaths, test } from "../fixtures";

test.describe("static-site smoke", () => {
  test("both instances serve traffic behind the load balancer", async ({ fleet }) => {
    expect(fleet.instances).toHaveLength(2);
    const upstreams = new Set<string | null>();
    for (let i = 0; i < 4; i++) upstreams.add((await getPage(fleet, "/about")).upstream);
    expect([...upstreams].sort()).toEqual(fleet.instances.map((m) => m.id).sort());
  });

  test("every sitemap path answers 200 on a prewarmed cache", async ({ fleet }) => {
    const paths = await sitemapPaths(fleet);
    expect(paths.filter((p) => p.startsWith("/docs/")).length).toBeGreaterThanOrEqual(100);
    const failures: string[] = [];
    for (const p of paths) {
      const { status } = await getPage(fleet, p);
      if (status !== 200) failures.push(`${status} ${p}`);
    }
    expect(failures).toEqual([]);
  });

  test("prerendered pages carry the build markers", async ({ fleet }) => {
    const page = await getPage(fleet, "/docs/guide/doc-0");
    expect(page.status).toBe(200);
    expect(page.build).toBe("A");
    expect(page.body.length).toBeGreaterThan(200_000);
  });

  test("OG image route answers a PNG", async ({ fleet }) => {
    const res = await fleet.request("/api/og/docs/guide/doc-0");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
  });

  test("segment prefetch of a page rendered at runtime answers 200", async ({ fleet }) => {
    // "/" is not prewarmed by 1.x (see 7-4), so Next renders and stores it itself
    expect((await getPage(fleet, "/")).status).toBe(200);
    expect((await segmentPrefetch(fleet, "/", "/_tree")).status).toBe(200);
  });
});
