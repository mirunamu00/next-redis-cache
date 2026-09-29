import { allSlugs, slugKey } from "../lib/content.mjs";

// Relative URLs are resolved by tests against whatever host serves the fleet.
const BASE = "http://localhost";

export default function sitemap() {
  return [
    { url: `${BASE}/` },
    { url: `${BASE}/about` },
    ...allSlugs().map((s) => ({ url: `${BASE}/docs/${slugKey(s)}` })),
  ];
}
