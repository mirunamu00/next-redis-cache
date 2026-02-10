import { Suspense } from "react";

const hasRedis = !!process.env.REDIS_URL;

async function getPrewarmStatus() {
  if (!hasRedis) return null;

  const { createClient } = await import("@redis/client");
  const buildId = process.env.BUILD_ID || "test-default";
  const client = createClient({ url: process.env.REDIS_URL });
  client.on("error", () => {});

  try {
    await client.connect();

    const keys: string[] = [];
    for await (const key of client.scanIterator({
      MATCH: `test:${buildId}:*`,
      COUNT: 200,
    })) {
      keys.push(String(key));
    }

    await client.quit();

    const cacheKeys = keys.filter(
      (k) =>
        !k.includes("_tags") &&
        !k.includes("_tagTtls") &&
        !k.includes("_useCache:") &&
        !k.includes("__revalidated")
    );
    return {
      buildId,
      totalKeys: keys.length,
      cacheKeys: cacheKeys.sort(),
      connected: true,
    };
  } catch (err) {
    try {
      await client.quit();
    } catch {}
    return {
      buildId,
      totalKeys: 0,
      cacheKeys: [] as string[],
      connected: false,
      error: String(err),
    };
  }
}

async function PrewarmStatus() {
  const status = await getPrewarmStatus();

  if (!status) {
    return (
      <div
        style={{
          padding: "1rem",
          background: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: 8,
          marginBottom: "1rem",
        }}
      >
        <p style={{ margin: 0, fontWeight: "bold", color: "#92400e" }}>
          Redis not connected
        </p>
        <p style={{ margin: "0.5rem 0 0", color: "#78716c", fontSize: "0.9rem" }}>
          This test requires a Redis connection to verify that{" "}
          <code>registerInitialCache</code> pre-loaded build artifacts.
          Set <code>REDIS_URL</code> in your environment to enable this test.
        </p>
      </div>
    );
  }

  return (
    <>
      <table style={{ borderCollapse: "collapse", marginBottom: "1rem" }}>
        <tbody>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Build ID</td>
            <td style={{ padding: "4px 12px", fontFamily: "monospace" }}>{status.buildId}</td>
          </tr>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Redis Connection</td>
            <td style={{ padding: "4px 12px" }}>{status.connected ? "OK" : "Failed"}</td>
          </tr>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Total Keys</td>
            <td style={{ padding: "4px 12px" }}>{status.totalKeys}</td>
          </tr>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Cache Keys</td>
            <td style={{ padding: "4px 12px" }}>{status.cacheKeys.length}</td>
          </tr>
        </tbody>
      </table>

      {status.cacheKeys.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <strong>Redis Cache Key List:</strong>
          <ul style={{ fontFamily: "monospace", fontSize: "0.85rem", margin: "0.5rem 0" }}>
            {status.cacheKeys.map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export default function PrewarmPage() {
  return (
    <div>
      <h1>C1. Prewarm Check</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Verifies that <code>registerInitialCache</code> pre-loaded build artifacts into Redis.
      </p>

      <Suspense fallback={<p style={{ color: "#888" }}>Querying Redis...</p>}>
        <PrewarmStatus />
      </Suspense>

      <div style={{ padding: "1rem", background: "#f0fff0", borderRadius: 8, fontSize: "0.9rem" }}>
        <strong>Verification:</strong>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li><code>npm run build</code> → <code>npm run start</code>, then visit this page</li>
          <li>If &quot;Cache Keys&quot; is greater than 0, prewarm succeeded</li>
          <li>Keys corresponding to pre-rendered routes (/, /tests/... etc.) should exist</li>
          <li><code>instrumentation.ts</code>&apos;s <code>registerInitialCache</code> was executed</li>
        </ol>
      </div>
    </div>
  );
}
