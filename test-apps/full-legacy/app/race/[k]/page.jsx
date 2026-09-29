import { getDatum } from "../../../lib/data.mjs";

// Slow render: the origin delay for `race-<k>` is set by the test (POST /delay/race-<k>) so an
// invalidation can land while this page is being regenerated (ROADMAP.md 7-6, chaos C13).
export const dynamicParams = true;
export const revalidate = 3600;

export function generateStaticParams() {
  return [];
}

export default async function RacePage({ params }) {
  const { k } = await params;
  const d = await getDatum(`race-${k}`, { tags: ["race", `race-${k}`] });
  return (
    <main>
      <p id="page">race</p>
      <p id="version" data-version={d.version}>
        {d.version}
      </p>
    </main>
  );
}
