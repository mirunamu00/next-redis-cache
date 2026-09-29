import { Suspense } from "react";
import { RemoteDatum } from "../../lib/cached.jsx";

// "use cache: remote" is not part of the prerendered shell, so it needs a Suspense boundary.
export default function RemotePage() {
  return (
    <main>
      <p id="page">remote</p>
      <Suspense fallback={<p id="fallback">loading</p>}>
        <RemoteDatum />
      </Suspense>
    </main>
  );
}
