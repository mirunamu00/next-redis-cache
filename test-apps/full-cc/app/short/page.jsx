import { Suspense } from "react";
import { ShortDatum } from "../../lib/cached.jsx";

// A cache life shorter than the prerender threshold is excluded from the static shell,
// so the short-lived entry is filled at request time behind a Suspense boundary.
export default function ShortPage() {
  return (
    <main>
      <p id="page">short</p>
      <Suspense fallback={<p id="fallback">loading</p>}>
        <ShortDatum />
      </Suspense>
    </main>
  );
}
