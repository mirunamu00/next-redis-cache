import { cacheLife, cacheTag } from "next/cache";
import { hooksEnabled, markerAttributes } from "../_shared/test-hooks.mjs";
import { dataUrl } from "../_shared/origin.mjs";

async function fetchDatum(key) {
  const res = await fetch(dataUrl(key));
  if (!res.ok) throw new Error(`origin ${res.status} for ${key}`);
  return res.json();
}

/** Render markers produced inside the cache scope: a new render id means the entry was regenerated. */
function Markers({ label }) {
  if (!hooksEnabled()) return null;
  return <div className="nrc-cache" data-label={label} hidden {...markerAttributes()} />;
}

function Datum({ label, d }) {
  return (
    <section id={label} data-version={d.version}>
      <Markers label={label} />
      <p className="version">{d.version}</p>
    </section>
  );
}

/** "use cache" + cacheTag + cacheLife("hours") */
export async function HoursDatum({ id }) {
  "use cache";
  cacheLife("hours");
  cacheTag("uc", `uc-${id}`);
  return <Datum label={`uc-${id}`} d={await fetchDatum(`uc-${id}`)} />;
}

/** custom profile short = { revalidate: 2, expire: 10 } */
export async function ShortDatum() {
  "use cache";
  cacheLife("short");
  cacheTag("short");
  return <Datum label="short" d={await fetchDatum("short")} />;
}

/** "use cache: remote" goes through cacheHandlers.remote */
export async function RemoteDatum() {
  "use cache: remote";
  cacheLife("hours");
  cacheTag("remote");
  return <Datum label="remote" d={await fetchDatum("remote")} />;
}

/** Cached shell for the PPR page. No origin fetch: an in-flight fetch at the moment the prerender
 *  aborts on the dynamic hole is reported as "filling a cache during prerender timed out". */
export async function PprShell() {
  "use cache";
  cacheLife("hours");
  cacheTag("ppr");
  return (
    <section id="ppr-shell">
      <Markers label="ppr" />
      <p>shell</p>
    </section>
  );
}
