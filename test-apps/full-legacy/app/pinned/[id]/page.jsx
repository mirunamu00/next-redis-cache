import { getDatum } from "../../../lib/data.mjs";

// docs pattern: only prerendered params exist and the page is invalidated on demand only.
// A miss after invalidation must still answer 200 (stale while revalidating), never 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ id: "1" }, { id: "2" }, { id: "3" }];
}

export default async function PinnedPage({ params }) {
  const { id } = await params;
  const d = await getDatum(`pinned-${id}`, { tags: ["pinned", `pinned-${id}`] });
  return (
    <main>
      <p id="page">pinned</p>
      <p id="version" data-version={d.version}>
        {d.version}
      </p>
    </main>
  );
}
