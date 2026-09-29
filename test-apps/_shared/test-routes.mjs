// Response builders for the /api/nrc-test/* routes. The route files stay tiny so that the same logic
// is shared by apps with and without cacheComponents (which differ in how a route opts out of caching).
import { hooksEnabled, snapshot } from "./test-hooks.mjs";

const NO_STORE = { "cache-control": "no-store" };

export function statsResponse() {
  if (!hooksEnabled()) return new Response("test hooks disabled", { status: 404, headers: NO_STORE });
  return Response.json(snapshot(), { headers: NO_STORE });
}

export function unhandledResponse() {
  if (!hooksEnabled()) return new Response("test hooks disabled", { status: 404, headers: NO_STORE });
  const s = snapshot();
  return Response.json({ unhandledRejections: s.unhandledRejections, lastErrors: s.lastErrors }, { headers: NO_STORE });
}
