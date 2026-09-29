// Known-bug reproductions on full-legacy (ROADMAP.md 7-1, 7-6). Expected failures on 1.0.6.
import { expect, getPage, repro, test } from "../fixtures";
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

test.describe("full-legacy reproductions", () => {
  test("[7-6] revalidatePath on a dynamicParams=false page keeps answering 200, then serves the new data", async ({ fleet }) => {
    repro("7-6", "1.x deletes the entry; the miss on a dynamicParams=false page becomes a 404");
    expect((await getPage(fleet, "/pinned/4")).status).toBe(200);
    fleet.origin!.bump("pinned-4");
    await invalidate(fleet, "path=/pinned/4");
    const statuses = await untilVersion(fleet, "/pinned/4", 2);
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
  });

  test("[7-1] revalidateTag(tag, 'max') on a pinned page serves stale, then the new data (never 404)", async ({ fleet }) => {
    repro("7-1", "1.x ignores the profile and deletes tagged entries, so the dynamicParams=false page 404s");
    expect((await getPage(fleet, "/pinned/5")).status).toBe(200);
    fleet.origin!.bump("pinned-5");
    await invalidate(fleet, "tag=pinned-5&profile=max");
    const statuses = await untilVersion(fleet, "/pinned/5", 2);
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
  });
});
