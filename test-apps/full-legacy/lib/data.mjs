import { dataUrl } from "../_shared/origin.mjs";

/** Fetches a versioned datum from the origin through the Next data cache (FETCH entries). */
export async function getDatum(key, { tags = [], revalidate } = {}) {
  const next = { tags };
  if (revalidate !== undefined) next.revalidate = revalidate;
  const res = await fetch(dataUrl(key), { cache: "force-cache", next });
  if (!res.ok) throw new Error(`origin ${res.status} for ${key}`);
  return res.json();
}
