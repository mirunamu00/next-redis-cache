import { ImageResponse } from "next/og";
import { ogSlugs, slugKey } from "../../../../../lib/content.mjs";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return ogSlugs().map((slug) => ({ slug }));
}

export async function GET(_req, { params }) {
  const { slug } = await params;
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0b1020", color: "#e0e6ff", fontSize: 48 }}>
      {slugKey(slug)}
    </div>,
    { width: 600, height: 315, headers: { "cache-control": "public, max-age=86400" } },
  );
}
