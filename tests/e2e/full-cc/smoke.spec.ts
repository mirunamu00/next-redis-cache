import { expect, getPage, test } from "../fixtures";

test.describe("full-cc smoke", () => {
  test("a use-cache entry is shared by both instances", async ({ fleet }) => {
    const a = await getPage(fleet, "/uc/11");
    const b = await getPage(fleet, "/uc/11");
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.upstream).not.toBe(b.upstream);
    expect(b.renderId).toBe(a.renderId);
    expect(fleet.origin!.hits("uc-11")).toBe(1);
  });

  test("remote cache handler serves the entry", async ({ fleet }) => {
    const a = await getPage(fleet, "/remote");
    const b = await getPage(fleet, "/remote");
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.version).toBe(a.version);
  });

  test("PPR page streams the shell and the dynamic part", async ({ fleet }) => {
    const page = await getPage(fleet, "/ppr");
    expect(page.status).toBe(200);
    expect(page.body).toContain('id="ppr-shell"');
    expect(page.body).toContain('id="dynamic"');
  });
});
