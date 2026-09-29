// Known-bug reproductions on full-cc (ROADMAP.md 7-1, A7). 7-1 is fixed in 1.1.0: 1.0.6 stored now + 1 year,
// so every later read of the tag was a miss for a year (5 origin fetches here instead of 1).
import { expect, getPage, submitActionForm, test } from "../fixtures";
import { waitFor } from "../../support/wait-for";

test.describe("full-cc reproductions", () => {
  test("[7-1] revalidateTag(tag, 'max'): one stale response, one regeneration, then hits (A7)", async ({ fleet }) => {
    const key = "uc-21";
    await getPage(fleet, "/uc/21");
    await getPage(fleet, "/uc/21");
    expect(fleet.origin!.hits(key)).toBe(1);
    fleet.origin!.bump(key);
    const res = await fleet.request(`/api/revalidate?tag=${key}&profile=max`, { method: "POST" });
    expect(res.status).toBe(200);

    await waitFor(async () => (await getPage(fleet, "/uc/21")).version === 2, {
      timeout: 10_000,
      interval: 200,
      message: "/uc/21 serves version 2",
    });
    const regenerations = fleet.origin!.hits(key) - 1;
    for (let i = 0; i < 4; i++) expect((await getPage(fleet, "/uc/21")).version).toBe(2);
    expect(fleet.origin!.hits(key) - 1, "origin fetches after the invalidation").toBe(regenerations);
    expect(regenerations).toBe(1);
  });

  test("updateTag in a server action makes the next request read the new data", async ({ fleet }) => {
    await getPage(fleet, "/uc/22");
    expect((await getPage(fleet, "/uc/22")).version).toBe(1);
    fleet.origin!.bump("uc-22");
    expect(await submitActionForm(fleet, "/actions", "update-uc")).toBeLessThan(400);
    expect((await getPage(fleet, "/uc/22")).version).toBe(2);
  });
});
