import { Suspense } from "react";

async function getDataA() {
  try {
    const res = await fetch("https://worldtimeapi.org/api/timezone/Asia/Seoul", {
      next: { revalidate: 300, tags: ["multi-shared", "multi-a"] },
    });
    if (!res.ok) return { datetime: new Date().toISOString(), fallback: true };
    const data = await res.json();
    return { datetime: data.datetime as string, fallback: false };
  } catch {
    return { datetime: new Date().toISOString(), fallback: true };
  }
}

async function getDataB() {
  try {
    const res = await fetch("https://worldtimeapi.org/api/timezone/Etc/UTC", {
      next: { revalidate: 300, tags: ["multi-shared", "multi-b"] },
    });
    if (!res.ok) return { datetime: new Date().toISOString(), fallback: true };
    const data = await res.json();
    return { datetime: data.datetime as string, fallback: false };
  } catch {
    return { datetime: new Date().toISOString(), fallback: true };
  }
}

async function MultiTagsContent() {
  const [dataA, dataB] = await Promise.all([getDataA(), getDataB()]);
  return (
    <>
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "1rem" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #ddd" }}>
            <th style={{ padding: "6px 12px", textAlign: "left" }}>Fetch</th>
            <th style={{ padding: "6px 12px", textAlign: "left" }}>Tags</th>
            <th style={{ padding: "6px 12px", textAlign: "left" }}>Value</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderBottom: "1px solid #eee" }}>
            <td style={{ padding: "6px 12px", fontWeight: "bold" }}>A (Seoul)</td>
            <td style={{ padding: "6px 12px" }}><code>multi-shared, multi-a</code></td>
            <td style={{ padding: "6px 12px", fontFamily: "monospace", fontSize: "0.85rem" }}>{dataA.datetime}</td>
          </tr>
          <tr style={{ borderBottom: "1px solid #eee" }}>
            <td style={{ padding: "6px 12px", fontWeight: "bold" }}>B (UTC)</td>
            <td style={{ padding: "6px 12px" }}><code>multi-shared, multi-b</code></td>
            <td style={{ padding: "6px 12px", fontFamily: "monospace", fontSize: "0.85rem" }}>{dataB.datetime}</td>
          </tr>
        </tbody>
      </table>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <a href="/api/revalidate?tag=multi-a&handler=legacy&redirect=/tests/legacy/multi-tags"
          style={{ display: "inline-block", padding: "8px 16px", background: "#16a34a", color: "white", borderRadius: 6, textDecoration: "none", fontSize: "0.9rem" }}>
          Revalidate &quot;multi-a&quot; only
        </a>
        <a href="/api/revalidate?tag=multi-b&handler=legacy&redirect=/tests/legacy/multi-tags"
          style={{ display: "inline-block", padding: "8px 16px", background: "#2563eb", color: "white", borderRadius: 6, textDecoration: "none", fontSize: "0.9rem" }}>
          Revalidate &quot;multi-b&quot; only
        </a>
        <a href="/api/revalidate?tag=multi-shared&handler=legacy&redirect=/tests/legacy/multi-tags"
          style={{ display: "inline-block", padding: "8px 16px", background: "#dc2626", color: "white", borderRadius: 6, textDecoration: "none", fontSize: "0.9rem" }}>
          Revalidate &quot;multi-shared&quot; (both)
        </a>
      </div>
    </>
  );
}

export default function MultiTagsPage() {
  return (
    <div>
      <h1>B3. Multi-tag Revalidate</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Tests individual and shared tag invalidation behavior when 2 fetches
        have a shared tag (&quot;multi-shared&quot;) and individual tags.
      </p>

      <Suspense fallback={<p style={{ color: "#888" }}>Loading data...</p>}>
        <MultiTagsContent />
      </Suspense>

      <div style={{ padding: "1rem", background: "#fff8f0", borderRadius: 8, fontSize: "0.9rem" }}>
        <strong>Verification:</strong>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li>&quot;multi-a&quot; click → Only A refreshed, B unchanged</li>
          <li>&quot;multi-b&quot; click → Only B refreshed, A unchanged</li>
          <li>&quot;multi-shared&quot; click → Both A and B refreshed</li>
        </ol>
      </div>
    </div>
  );
}
