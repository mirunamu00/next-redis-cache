import { getDatum } from "../../lib/data.mjs";

// Dynamic page whose data comes from tagged, cached fetches (FETCH entries in the legacy handler).
export const dynamic = "force-dynamic";

export default async function FetchTagsPage() {
  const a = await getDatum("ft-a", { tags: ["ft", "ft-a"] });
  const b = await getDatum("ft-b", { tags: ["ft", "ft-b"], revalidate: 3600 });
  return (
    <main>
      <p id="page">fetch-tags</p>
      <p id="a" data-version={a.version}>
        {a.version}
      </p>
      <p id="b" data-version={b.version}>
        {b.version}
      </p>
    </main>
  );
}
