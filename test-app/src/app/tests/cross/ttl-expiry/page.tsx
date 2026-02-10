import { Suspense } from "react";
import { cacheLife } from "next/cache";
import { TtlMonitor } from "./ttl-monitor";

async function getShortLived() {
  "use cache";
  cacheLife({ stale: 3, revalidate: 5, expire: 10 });
  return { value: Date.now(), generated: new Date().toISOString() };
}

async function TtlContent() {
  const data = await getShortLived();

  return (
    <>
      <table style={{ borderCollapse: "collapse", marginBottom: "1rem" }}>
        <tbody>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>cacheLife</td>
            <td style={{ padding: "4px 12px", fontFamily: "monospace" }}>
              {"{ stale: 3, revalidate: 5, expire: 10 }"}
            </td>
          </tr>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Cached value</td>
            <td style={{ padding: "4px 12px", fontFamily: "monospace" }}>{data.value}</td>
          </tr>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Generated at</td>
            <td style={{ padding: "4px 12px", fontFamily: "monospace" }}>{data.generated}</td>
          </tr>
        </tbody>
      </table>

      <TtlMonitor generatedAt={data.generated} />
    </>
  );
}

export default function TtlExpiryPage() {
  return (
    <div>
      <h1>C5. TTL Expiry</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Sets a short TTL to observe cache expiration in real time.
      </p>

      <Suspense fallback={<p style={{ color: "#888" }}>Loading cache data...</p>}>
        <TtlContent />
      </Suspense>

      <div style={{ padding: "1rem", background: "#f0f8ff", borderRadius: 8, fontSize: "0.9rem", marginTop: "1rem" }}>
        <strong>Verification:</strong>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li>Timer starts automatically after page load</li>
          <li>Within 3 seconds: cache HIT (fresh)</li>
          <li>3~5 seconds: stale state (HIT, but background revalidate possible)</li>
          <li>After 10 seconds: cache expired → MISS → new value generated</li>
          <li>Enable &quot;Auto-refresh&quot; to check automatically every 2 seconds</li>
        </ol>
      </div>
    </div>
  );
}
