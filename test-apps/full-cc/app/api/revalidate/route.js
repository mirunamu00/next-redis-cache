import { connection } from "next/server";
import { applyRevalidation } from "../../../lib/revalidate.mjs";

// POST /api/revalidate?tag=uc&profile=max|expire:60 (updateTag is server-action only)
export async function POST(req) {
  await connection();
  const q = new URL(req.url).searchParams;
  applyRevalidation({ tag: q.get("tag") ?? undefined, profile: q.get("profile") ?? "max" });
  return Response.json({ ok: true, at: Date.now() });
}
