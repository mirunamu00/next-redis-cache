import { connection } from "next/server";
import { unhandledResponse } from "../../../../_shared/test-routes.mjs";

export async function GET() {
  await connection();
  return unhandledResponse();
}
