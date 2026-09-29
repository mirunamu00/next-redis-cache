import { connection } from "next/server";
import { statsResponse } from "../../../../_shared/test-routes.mjs";

// cacheComponents forbids `export const dynamic`; connection() opts the handler out of prerendering.
export async function GET() {
  await connection();
  return statsResponse();
}
