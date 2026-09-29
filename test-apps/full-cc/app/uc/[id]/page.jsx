import { HoursDatum } from "../../../lib/cached.jsx";

export function generateStaticParams() {
  return [{ id: "1" }, { id: "2" }];
}

export default async function UcPage({ params }) {
  const { id } = await params;
  return (
    <main>
      <p id="page">uc</p>
      <HoursDatum id={id} />
    </main>
  );
}
