import { Suspense } from "react";
import { CurrentTime } from "../../current-time";

async function getCachedTimestamp() {
  "use cache";
  return { value: Date.now(), generated: new Date().toISOString() };
}

async function BasicContent() {
  const data = await getCachedTimestamp();
  return (
    <>
      <table style={{ borderCollapse: "collapse", marginBottom: "1rem" }}>
        <tbody>
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
    </>
  );
}

export default function BasicUseCachePage() {
  return (
    <div>
      <h1>A1. Basic &quot;use cache&quot;</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Verifies that function results are cached. If the same value is returned on refresh, it&apos;s a cache HIT.
      </p>

      <Suspense fallback={<p style={{ color: "#888" }}>Loading data...</p>}>
        <BasicContent />
      </Suspense>

      <div style={{ padding: "1rem", background: "#f0f8ff", borderRadius: 8, fontSize: "0.9rem" }}>
        <strong>Verification:</strong>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li>First visit: Check <code>use-cache set</code> in the log panel below</li>
          <li>Refresh: Check <code>use-cache get HIT</code>, &quot;Cached value&quot; stays the same</li>
          <li>Only &quot;Current time&quot; changes while &quot;Generated at&quot; remains fixed</li>
        </ol>
      </div>
    </div>
  );
}
