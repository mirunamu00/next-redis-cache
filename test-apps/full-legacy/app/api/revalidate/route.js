import { applyRevalidation } from "../../../lib/revalidate.mjs";

// POST /api/revalidate?tag=pinned&profile=max|none|expire:60  or  ?path=/pinned/1
// Same invalidations as the server actions, callable without a browser (chaos, perf).
export const dynamic = "force-dynamic";

export async function POST(req) {
  const q = new URL(req.url).searchParams;
  applyRevalidation({ tag: q.get("tag") ?? undefined, path: q.get("path") ?? undefined, profile: q.get("profile") ?? "max" });
  return Response.json({ ok: true, at: Date.now() });
}
