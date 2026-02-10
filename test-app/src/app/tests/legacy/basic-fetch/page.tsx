import { Suspense } from "react";

async function getData() {
  try {
    const res = await fetch("https://worldtimeapi.org/api/timezone/Etc/UTC", {
      next: { revalidate: 60 },
    });
    if (!res.ok) return { datetime: new Date().toISOString(), fallback: true };
    const data = await res.json();
    return { datetime: data.datetime as string, fallback: false };
  } catch {
    return { datetime: new Date().toISOString(), fallback: true };
  }
}

async function FetchContent() {
  const data = await getData();
  return (
    <table style={{ borderCollapse: "collapse", marginBottom: "1rem" }}>
      <tbody>
        <tr>
          <td style={{ padding: "4px 12px", fontWeight: "bold" }}>UTC time</td>
          <td style={{ padding: "4px 12px", fontFamily: "monospace" }}>{data.datetime}</td>
        </tr>
        <tr>
          <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Fallback</td>
          <td style={{ padding: "4px 12px" }}>{data.fallback ? "Yes (API unreachable)" : "No"}</td>
        </tr>
        <tr>
          <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Revalidate</td>
          <td style={{ padding: "4px 12px" }}>60s</td>
        </tr>
      </tbody>
    </table>
  );
}

export default function BasicFetchPage() {
  return (
    <div>
      <h1>B1. Basic Fetch Cache</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Tests fetch data caching through the legacy handler with
        <code>fetch(url, {"{"} next: {"{"} revalidate: 60 {"}"} {"}"})</code>.
      </p>

      <Suspense fallback={<p style={{ color: "#888" }}>Loading data...</p>}>
        <FetchContent />
      </Suspense>

      <div style={{ padding: "1rem", background: "#fff8f0", borderRadius: 8, fontSize: "0.9rem" }}>
        <strong>Verification:</strong>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li>First visit: <code>legacy set</code> recorded in the logs</li>
          <li>Refresh: <code>legacy get HIT</code>, UTC time unchanged</li>
          <li>Refresh after 60s: Value updated (stale-while-revalidate)</li>
          <li>This page uses a singular <code>cacheHandler</code></li>
        </ol>
      </div>
    </div>
  );
}
