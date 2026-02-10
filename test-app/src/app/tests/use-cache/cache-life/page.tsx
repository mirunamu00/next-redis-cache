import { Suspense } from "react";
import { cacheLife } from "next/cache";
import { CurrentTime } from "../../current-time";

async function getWithSeconds() {
  "use cache";
  cacheLife("seconds");
  return { profile: "seconds", ts: Date.now(), generated: new Date().toISOString() };
}

async function getWithMinutes() {
  "use cache";
  cacheLife("minutes");
  return { profile: "minutes", ts: Date.now(), generated: new Date().toISOString() };
}

async function getWithHours() {
  "use cache";
  cacheLife("hours");
  return { profile: "hours", ts: Date.now(), generated: new Date().toISOString() };
}

async function CacheLifeContent() {
  const [seconds, minutes, hours] = await Promise.all([
    getWithSeconds(),
    getWithMinutes(),
    getWithHours(),
  ]);

  const results = [seconds, minutes, hours];

  return (
    <>
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "1rem" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #ddd" }}>
            <th style={{ padding: "6px 12px", textAlign: "left" }}>Profile</th>
            <th style={{ padding: "6px 12px", textAlign: "left" }}>Generated at</th>
            <th style={{ padding: "6px 12px", textAlign: "left" }}>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.profile} style={{ borderBottom: "1px solid #eee" }}>
              <td style={{ padding: "6px 12px", fontWeight: "bold" }}>
                <code>{r.profile}</code>
              </td>
              <td style={{ padding: "6px 12px", fontFamily: "monospace", fontSize: "0.85rem" }}>
                {r.generated}
              </td>
              <td style={{ padding: "6px 12px", fontFamily: "monospace", fontSize: "0.85rem" }}>
                {r.ts}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ fontFamily: "monospace", fontSize: "0.85rem", color: "#888" }}>
        Current time: <CurrentTime />
      </p>
    </>
  );
}

export default function CacheLifePage() {
  return (
    <div>
      <h1>A2. cacheLife Profiles</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Compares TTL differences across different cacheLife profiles (seconds, minutes, hours).
      </p>

      <Suspense fallback={<p style={{ color: "#888" }}>Loading data...</p>}>
        <CacheLifeContent />
      </Suspense>

      <div style={{ padding: "1rem", background: "#f0f8ff", borderRadius: 8, fontSize: "0.9rem" }}>
        <strong>Verification:</strong>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li>First visit: All 3 functions are generated at the same time</li>
          <li>Refresh after a few seconds: Only the seconds value changes (stale: 5s, revalidate: 1s)</li>
          <li>Refresh after a few minutes: seconds + minutes change, hours remains the same</li>
        </ol>
      </div>
    </div>
  );
}
