import { getDatum } from "../../../lib/data.mjs";

// Time-based ISR: stale after 2s, regenerated in the background (legacy SWR).
export const revalidate = 2;

export function generateStaticParams() {
  return [{ id: "1" }, { id: "2" }];
}

export default async function IsrPage({ params }) {
  const { id } = await params;
  const d = await getDatum(`isr-${id}`, { tags: ["isr", `isr-${id}`], revalidate: 2 });
  return (
    <main>
      <p id="page">isr</p>
      <p id="version" data-version={d.version}>
        {d.version}
      </p>
    </main>
  );
}
