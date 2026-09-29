import { Suspense } from "react";
import { connection } from "next/server";
import { HoursDatum } from "../../../lib/cached.jsx";

// Request-time page: every request runs the "use cache" lookup (the page itself is never cached),
// so chaos and perf tests can drive the use-cache handler directly.
async function Dynamic({ params }) {
  await connection();
  const { id } = await params;
  return <HoursDatum id={`dyn-${id}`} />;
}

export default function DynPage({ params }) {
  return (
    <main>
      <p id="page">dyn</p>
      <Suspense fallback={<p id="fallback">loading</p>}>
        <Dynamic params={params} />
      </Suspense>
    </main>
  );
}
