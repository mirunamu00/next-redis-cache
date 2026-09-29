// Regressions on full-legacy (ROADMAP.md 7-6, A7). Expected failures on 1.x, fixed in 2.0: invalidations mark
// tags stale/expired instead of deleting entries, so a dynamicParams=false page is served stale, never 404.
import { expect, getPage, test } from "../fixtures";
import { waitFor } from "../../support/wait-for";

/** Polls until `page` serves `version`; the error lists every status seen on the way. */
async function untilVersion(fleet: import("../fixtures").Fleet, page: string, version: number): Promise<number[]> {
  const statuses: number[] = [];
  try {
    await waitFor(
      async () => {
        const p = await getPage(fleet, page);
        statuses.push(p.status);
        return p.version === version;
      },
      { timeout: 10_000, interval: 200, message: `${page} serves version ${version}` },
    );
  } catch (err) {
    throw new Error(`${(err as Error).message}; statuses seen: ${[...new Set(statuses)].join(", ")}`, { cause: err });
  }
  return statuses;
}

async function invalidate(fleet: import("../fixtures").Fleet, query: string) {
  const res = await fleet.request(`/api/revalidate?${query}`, { method: "POST" });
  expect(res.status).toBe(200);
}

test.describe("full-legacy regressions", () => {
  test("[7-6] revalidatePath on a dynamicParams=false page keeps answering 200, then serves the new data", async ({ fleet }) => {
    expect((await getPage(fleet, "/pinned/4")).status).toBe(200);
    fleet.origin!.bump("pinned-4");
    await invalidate(fleet, "path=/pinned/4");
    const statuses = await untilVersion(fleet, "/pinned/4", 2);
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
  });

  test("[7-6] revalidateTag(tag, 'max') on a pinned page serves stale, then the new data (never 404)", async ({ fleet }) => {
    expect((await getPage(fleet, "/pinned/5")).status).toBe(200);
    fleet.origin!.bump("pinned-5");
    await invalidate(fleet, "tag=pinned-5&profile=max");
    const statuses = await untilVersion(fleet, "/pinned/5", 2);
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
  });
});
