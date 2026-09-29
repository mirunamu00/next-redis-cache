// Route handler revalidated every 5s (APP_ROUTE entry with revalidate; ROADMAP.md 7-11).
export const revalidate = 5;

export function GET() {
  return Response.json({ route: "timed", builtAt: Date.now() });
}
