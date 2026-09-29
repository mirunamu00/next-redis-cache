// Hidden element with render markers (TEST_HOOKS=1 only). Tests read these attributes to tell which
// build, render and instance produced a response: a new data-render-id means the page was regenerated.
import { hooksEnabled, markerAttributes } from "./test-hooks.mjs";

export function TestMarkers() {
  if (!hooksEnabled()) return null;
  return <div id="nrc-test" hidden {...markerAttributes()} />;
}
