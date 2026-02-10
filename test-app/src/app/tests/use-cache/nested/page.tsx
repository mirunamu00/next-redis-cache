import { Suspense } from "react";
import { cacheLife, cacheTag } from "next/cache";

async function innerCached() {
  "use cache";
  cacheLife("hours");
  cacheTag("nested-inner");
  return { value: Date.now(), generated: new Date().toISOString() };
}

async function outerCached() {
  "use cache";
  cacheLife("hours");
  cacheTag("nested-outer");
  const inner = await innerCached();
  return {
    inner,
    outer: { value: Date.now(), generated: new Date().toISOString() },
  };
}

async function NestedContent() {
  const data = await outerCached();
  return (
    <>
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "1rem" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #ddd" }}>
            <th style={{ padding: "6px 12px", textAlign: "left" }}>Layer</th>
            <th style={{ padding: "6px 12px", textAlign: "left" }}>Tag</th>
            <th style={{ padding: "6px 12px", textAlign: "left" }}>Generated</th>
            <th style={{ padding: "6px 12px", textAlign: "left" }}>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderBottom: "1px solid #eee" }}>
            <td style={{ padding: "6px 12px", fontWeight: "bold" }}>outer</td>
            <td style={{ padding: "6px 12px" }}><code>nested-outer</code></td>
            <td style={{ padding: "6px 12px", fontFamily: "monospace", fontSize: "0.85rem" }}>
              {data.outer.generated}
            </td>
            <td style={{ padding: "6px 12px", fontFamily: "monospace", fontSize: "0.85rem" }}>
              {data.outer.value}
            </td>
          </tr>
          <tr style={{ borderBottom: "1px solid #eee" }}>
            <td style={{ padding: "6px 12px", fontWeight: "bold" }}>inner</td>
            <td style={{ padding: "6px 12px" }}><code>nested-inner</code></td>
            <td style={{ padding: "6px 12px", fontFamily: "monospace", fontSize: "0.85rem" }}>
              {data.inner.generated}
            </td>
            <td style={{ padding: "6px 12px", fontFamily: "monospace", fontSize: "0.85rem" }}>
              {data.inner.value}
            </td>
          </tr>
        </tbody>
      </table>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <a
          href="/api/revalidate?tag=nested-inner&handler=default&redirect=/tests/use-cache/nested"
          style={{
            display: "inline-block",
            padding: "8px 16px",
            background: "#16a34a",
            color: "white",
            borderRadius: 6,
            textDecoration: "none",
            fontSize: "0.9rem",
          }}
        >
          Revalidate inner
        </a>
        <a
          href="/api/revalidate?tag=nested-outer&handler=default&redirect=/tests/use-cache/nested"
          style={{
            display: "inline-block",
            padding: "8px 16px",
            background: "#0070f3",
            color: "white",
            borderRadius: 6,
            textDecoration: "none",
            fontSize: "0.9rem",
          }}
        >
          Revalidate outer
        </a>
      </div>
    </>
  );
}

export default function NestedCachePage() {
  return (
    <div>
      <h1>A5. Nested Cache Functions</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Verifies that parent (outer) and child (inner) cache functions are cached independently.
      </p>

      <Suspense fallback={<p style={{ color: "#888" }}>Loading data...</p>}>
        <NestedContent />
      </Suspense>

      <div style={{ padding: "1rem", background: "#f0f8ff", borderRadius: 8, fontSize: "0.9rem" }}>
        <strong>Verification:</strong>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li>Click &quot;Revalidate inner&quot; → Only inner value changes, outer remains the same</li>
          <li>Click &quot;Revalidate outer&quot; → outer changes, inner is loaded from cache</li>
          <li>Check logs for independent get/set operations per layer</li>
        </ol>
      </div>
    </div>
  );
}
