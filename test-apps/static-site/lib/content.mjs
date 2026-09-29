// Deterministic content for static-site: every page body is generated from a seed, so builds are
// reproducible and sizes resemble real documentation pages (200-500 KB of HTML per page).
//
// NRC_STATIC_PAGES overrides the page count (default 120); NRC_STATIC_OG the OG image count (default 50).

const PAGE_COUNT = Number(process.env.NRC_STATIC_PAGES ?? 120);
const OG_COUNT = Number(process.env.NRC_STATIC_OG ?? 50);
const CATEGORIES = ["guide", "reference", "tutorial", "ops", "api", "concepts"];
const WORDS = (
  "cache redis next handler build page segment prefetch render stream tag revalidate stale fresh " +
  "expire lifetime instance rolling deploy cluster memory eviction timeout circuit fallback disk " +
  "namespace envelope binary buffer payload latency throughput replica primary snapshot append"
).split(" ");

/** mulberry32 PRNG */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Slugs: mostly category/doc-N, every fifth one nested one level deeper. */
export function allSlugs() {
  const slugs = [];
  for (let i = 0; i < PAGE_COUNT; i++) {
    const cat = CATEGORIES[i % CATEGORIES.length];
    slugs.push(i % 5 === 4 ? [cat, `section-${i % 3}`, `doc-${i}`] : [cat, `doc-${i}`]);
  }
  return slugs;
}

export const ogSlugs = () => allSlugs().slice(0, OG_COUNT);

export const slugKey = (slug) => slug.join("/");

export function findDoc(slug) {
  const key = slugKey(slug);
  const index = allSlugs().findIndex((s) => slugKey(s) === key);
  return index < 0 ? null : doc(index);
}

/** One document: 100-250 KB of text, which renders to roughly 200-500 KB of HTML (the HTML also inlines the RSC payload). */
export function doc(index) {
  const slug = allSlugs()[index];
  const r = rng(index + 1);
  const target = 100_000 + Math.floor(r() * 150_000);
  const paragraphs = [];
  let size = 0;
  while (size < target) {
    const n = 40 + Math.floor(r() * 80);
    const words = [];
    for (let w = 0; w < n; w++) words.push(WORDS[Math.floor(r() * WORDS.length)]);
    const p = words.join(" ");
    paragraphs.push(p);
    size += p.length + 7;
  }
  return { index, slug, title: `Document ${index}: ${slug.join(" / ")}`, paragraphs };
}
