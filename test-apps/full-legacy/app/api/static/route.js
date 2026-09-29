// Fully static route handler (APP_ROUTE entry without revalidate).
export const dynamic = "force-static";

export function GET() {
  return Response.json({ route: "static", builtAt: Date.now() });
}
