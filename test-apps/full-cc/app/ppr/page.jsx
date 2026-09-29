import { Suspense } from "react";
import { connection } from "next/server";
import { PprShell } from "../../lib/cached.jsx";

// Partial prerendering: cached shell plus a dynamic hole, so the prerendered entry carries `postponed` state.
async function DynamicPart() {
  await connection();
  return <p id="dynamic" data-now={Date.now()}>dynamic</p>;
}

export default function PprPage() {
  return (
    <main>
      <p id="page">ppr</p>
      <PprShell />
      <Suspense fallback={<p id="fallback">loading</p>}>
        <DynamicPart />
      </Suspense>
    </main>
  );
}
