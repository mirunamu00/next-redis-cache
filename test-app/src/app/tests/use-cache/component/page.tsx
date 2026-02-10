import { cacheLife } from "next/cache";

export default async function ComponentCachePage() {
  "use cache";
  cacheLife("minutes");

  const now = new Date().toISOString();
  const ts = Date.now();

  return (
    <div>
      <h1>A4. Component Caching</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Verifies that the entire component output is cached via page-level &quot;use cache&quot;.
      </p>

      <div style={{
        padding: "1.5rem",
        background: "#f5f0ff",
        borderRadius: 8,
        marginBottom: "1rem",
        border: "1px solid #e0d0ff",
      }}>
        <p style={{ margin: 0 }}>
          <strong>This entire page is cached</strong>
        </p>
        <p style={{ margin: "0.5rem 0 0", fontFamily: "monospace" }}>
          Generated: {now}
        </p>
        <p style={{ margin: "0.5rem 0 0", fontFamily: "monospace" }}>
          Timestamp: {ts}
        </p>
      </div>

      <div style={{ padding: "1rem", background: "#f0f8ff", borderRadius: 8, fontSize: "0.9rem" }}>
        <strong>Verification:</strong>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li>First visit: The entire page is cached (set log)</li>
          <li>Refresh: Same timestamp displayed (HIT)</li>
          <li>&quot;use cache&quot; is applied to the component itself, not a function</li>
          <li>5-minute cache via cacheLife(&quot;minutes&quot;)</li>
        </ol>
      </div>
    </div>
  );
}
