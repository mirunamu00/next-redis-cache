import { notFound } from "next/navigation";
import { allSlugs, findDoc, slugKey } from "../../../../lib/content.mjs";

// Only prerendered paths exist (docs pattern). A cache miss on one of them must never turn into a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return allSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  return {
    title: `doc ${slugKey(slug)}`,
    openGraph: { images: [`/api/og/docs/${slugKey(slug)}`] },
  };
}

export default async function DocPage({ params }) {
  const { slug } = await params;
  const d = findDoc(slug);
  if (!d) notFound();
  return (
    <article>
      <h1 id="title">{d.title}</h1>
      <p id="page" data-slug={slugKey(slug)}>
        doc
      </p>
      {d.paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </article>
  );
}
