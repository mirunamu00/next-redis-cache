import { expect, getPage, test } from "../fixtures";
import { waitFor } from "../../support/wait-for";

test.describe("full-legacy smoke", () => {
  test("time-based ISR serves the stale page, then the regenerated one", async ({ fleet }) => {
    const first = await getPage(fleet, "/isr/2");
    expect(first.status).toBe(200);
    fleet.origin!.bump("isr-2");
    await new Promise((r) => setTimeout(r, 2500)); // revalidate = 2
    await waitFor(async () => (await getPage(fleet, "/isr/2")).version === first.version! + 1, {
      timeout: 15_000,
      interval: 250,
      message: "regenerated /isr/2 with the new origin version",
    });
  });

  test("route handlers answer (static and revalidated)", async ({ fleet }) => {
    for (const p of ["/api/static", "/api/timed"]) {
      const res = await fleet.request(p);
      expect(res.status, p).toBe(200);
      expect(((await res.json()) as { route: string }).route).toBe(p.split("/").pop());
    }
  });

  test("prewarmed dynamicParams=false pages answer 200", async ({ fleet }) => {
    for (const id of [1, 2, 3]) expect((await getPage(fleet, `/pinned/${id}`)).status).toBe(200);
  });

  test("dynamic page with tagged fetches renders", async ({ fleet }) => {
    const page = await getPage(fleet, "/fetch-tags");
    expect(page.status).toBe(200);
    expect(page.body).toContain('id="a"');
  });
});
