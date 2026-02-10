import { Suspense } from "react";

async function getTaggedData() {
  try {
    const res = await fetch("https://worldtimeapi.org/api/timezone/Asia/Seoul", {
      next: { revalidate: 120, tags: ["b2-data"] },
    });
    if (!res.ok) return { datetime: new Date().toISOString(), fallback: true };
    const data = await res.json();
    return { datetime: data.datetime as string, fallback: false };
  } catch {
    return { datetime: new Date().toISOString(), fallback: true };
  }
}

async function FetchTagsContent() {
  const data = await getTaggedData();
  return (
    <>
      <table style={{ borderCollapse: "collapse", marginBottom: "1rem" }}>
        <tbody>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Tag</td>
            <td style={{ padding: "4px 12px" }}><code>b2-data</code></td>
          </tr>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Seoul time</td>
            <td style={{ padding: "4px 12px", fontFamily: "monospace" }}>{data.datetime}</td>
          </tr>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Fallback</td>
            <td style={{ padding: "4px 12px" }}>{data.fallback ? "Yes" : "No"}</td>
          </tr>
        </tbody>
      </table>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <a
          href="/api/revalidate?tag=b2-data&handler=legacy&redirect=/tests/legacy/fetch-tags"
          style={{ display: "inline-block", padding: "8px 16px", background: "#f59e0b", color: "white", borderRadius: 6, textDecoration: "none", fontSize: "0.9rem" }}
        >
          Revalidate &quot;b2-data&quot;
        </a>
      </div>
    </>
  );
}

export default function FetchTagsPage() {
  return (
    <div>
      <h1>B2. fetch + tags</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Verifies that tags are registered with
        <code>fetch(url, {"{"} next: {"{"} revalidate: 120, tags: [&quot;b2-data&quot;] {"}"} {"}"})</code>.
      </p>

      <Suspense fallback={<p style={{ color: "#888" }}>Loading data...</p>}>
        <FetchTagsContent />
      </Suspense>

      <div style={{ padding: "1rem", background: "#fff8f0", borderRadius: 8, fontSize: "0.9rem" }}>
        <strong>Verification:</strong>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li>First visit: legacy set log + &quot;b2-data&quot; recorded in Redis <code>_tags</code> hash</li>
          <li>Refresh: legacy get HIT</li>
          <li>&quot;Revalidate&quot; click: Value updated, legacy get MISS → set sequence</li>
          <li>Can be verified in the Cached Data panel below</li>
        </ol>
      </div>
    </div>
  );
}
