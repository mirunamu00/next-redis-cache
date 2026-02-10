import { Suspense } from "react";
import { cacheLife, cacheTag } from "next/cache";
import { CurrentTime } from "../../current-time";

async function getTaggedData() {
  "use cache";
  cacheLife("hours");
  cacheTag("test-tag-a3");
  return { value: Date.now(), generated: new Date().toISOString() };
}

async function CacheTagContent() {
  const data = await getTaggedData();
  return (
    <>
      <table style={{ borderCollapse: "collapse", marginBottom: "1rem" }}>
        <tbody>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Tag</td>
            <td style={{ padding: "4px 12px" }}><code>test-tag-a3</code></td>
          </tr>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Cached value</td>
            <td style={{ padding: "4px 12px", fontFamily: "monospace" }}>{data.value}</td>
          </tr>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Generated at</td>
            <td style={{ padding: "4px 12px", fontFamily: "monospace" }}>{data.generated}</td>
          </tr>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Current time</td>
            <td style={{ padding: "4px 12px", fontFamily: "monospace" }}><CurrentTime /></td>
          </tr>
        </tbody>
      </table>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <a
          href="/api/revalidate?tag=test-tag-a3&handler=default&redirect=/tests/use-cache/cache-tag"
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
          Revalidate &quot;test-tag-a3&quot;
        </a>
      </div>
    </>
  );
}

export default function CacheTagPage() {
  return (
    <div>
      <h1>A3. cacheTag + revalidateTag</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Tests tag-based on-demand invalidation.
        Invalidates data cached with the &quot;test-tag-a3&quot; tag using revalidateTag.
      </p>

      <Suspense fallback={<p style={{ color: "#888" }}>Loading data...</p>}>
        <CacheTagContent />
      </Suspense>

      <div style={{ padding: "1rem", background: "#f0f8ff", borderRadius: 8, fontSize: "0.9rem" }}>
        <strong>Verification:</strong>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li>First visit: Check the value, look for set entry in logs</li>
          <li>Refresh: Same value (HIT)</li>
          <li>Click &quot;Revalidate&quot; button: Value changes (regenerated after invalidation)</li>
          <li>Check logs for revalidateTag → get MISS → set sequence</li>
        </ol>
      </div>
    </div>
  );
}
