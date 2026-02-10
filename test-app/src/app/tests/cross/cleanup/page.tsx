import { Suspense } from "react";
import { createClient } from "@redis/client";

async function getKeyPrefixes() {
  const buildId = process.env.BUILD_ID || "test-default";
  const client = createClient({
    url: process.env.REDIS_URL,
  });
  client.on("error", () => {});

  try {
    await client.connect();

    const keys: string[] = [];
    for await (const key of client.scanIterator({ MATCH: "test:*", COUNT: 200 })) {
      keys.push(String(key));
    }

    await client.quit();

    const prefixes = new Map<string, number>();
    for (const key of keys) {
      const parts = key.split(":");
      if (parts.length >= 2) {
        const prefix = `${parts[0]}:${parts[1]}:`;
        prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1);
      }
    }

    return {
      buildId,
      currentPrefix: `test:${buildId}:`,
      prefixes: Array.from(prefixes.entries())
        .map(([prefix, count]) => ({ prefix, count, isCurrent: prefix === `test:${buildId}:` }))
        .sort((a, b) => a.prefix.localeCompare(b.prefix)),
      totalKeys: keys.length,
      connected: true,
    };
  } catch (err) {
    try { await client.quit(); } catch {}
    return {
      buildId,
      currentPrefix: `test:${buildId}:`,
      prefixes: [] as { prefix: string; count: number; isCurrent: boolean }[],
      totalKeys: 0,
      connected: false,
      error: String(err),
    };
  }
}

async function CleanupStatus() {
  const data = await getKeyPrefixes();

  return (
    <>
      <table style={{ borderCollapse: "collapse", marginBottom: "1rem" }}>
        <tbody>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Current Build ID</td>
            <td style={{ padding: "4px 12px", fontFamily: "monospace" }}>{data.buildId}</td>
          </tr>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Current Prefix</td>
            <td style={{ padding: "4px 12px", fontFamily: "monospace" }}>{data.currentPrefix}</td>
          </tr>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Total test:* keys</td>
            <td style={{ padding: "4px 12px" }}>{data.totalKeys}</td>
          </tr>
        </tbody>
      </table>

      <h3 style={{ margin: "1rem 0 0.5rem" }}>Key Distribution by Prefix</h3>
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "1rem" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #ddd" }}>
            <th style={{ padding: "6px 12px", textAlign: "left" }}>Prefix</th>
            <th style={{ padding: "6px 12px", textAlign: "left" }}>Key Count</th>
            <th style={{ padding: "6px 12px", textAlign: "left" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.prefixes.map((p) => (
            <tr key={p.prefix} style={{ borderBottom: "1px solid #eee" }}>
              <td style={{ padding: "6px 12px", fontFamily: "monospace", fontSize: "0.85rem" }}>
                {p.prefix}
              </td>
              <td style={{ padding: "6px 12px" }}>{p.count}</td>
              <td style={{ padding: "6px 12px" }}>
                {p.isCurrent ? (
                  <span style={{ color: "#16a34a", fontWeight: "bold" }}>Current build</span>
                ) : (
                  <span style={{ color: "#dc2626" }}>Previous build (cleanup target)</span>
                )}
              </td>
            </tr>
          ))}
          {data.prefixes.length === 0 && (
            <tr>
              <td colSpan={3} style={{ padding: "6px 12px", color: "#888" }}>
                No keys
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

export default function CleanupPage() {
  return (
    <div>
      <h1>C2. Build Key Cleanup</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Verifies that <code>cleanupOldBuildKeys</code> cleans up Redis keys from previous builds.
      </p>

      <Suspense fallback={<p style={{ color: "#888" }}>Querying Redis...</p>}>
        <CleanupStatus />
      </Suspense>

      <div style={{ padding: "1rem", background: "#f0fff0", borderRadius: 8, fontSize: "0.9rem" }}>
        <strong>Verification:</strong>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li>Build multiple times with different BUILD_IDs: <code>BUILD_ID=v1 npm run build</code></li>
          <li>On new build start, instrumentation runs <code>cleanupOldBuildKeys</code></li>
          <li>If no previous build prefix keys appear on this page, cleanup succeeded</li>
          <li>If &quot;Previous build&quot; entries remain, cleanup logic needs investigation</li>
        </ol>
      </div>
    </div>
  );
}
