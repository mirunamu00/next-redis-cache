import { Suspense } from "react";
import { cacheLife } from "next/cache";

async function getCachedValue() {
  "use cache";
  cacheLife("minutes");
  return { value: Date.now(), generated: new Date().toISOString() };
}

async function ReconnectContent() {
  let data;
  let error: string | null = null;

  try {
    data = await getCachedValue();
  } catch (err) {
    error = String(err);
    data = null;
  }

  return (
    <div style={{
      padding: "1rem",
      background: error ? "#fff0f0" : "#f0fff0",
      borderRadius: 8,
      marginBottom: "1rem",
      border: `1px solid ${error ? "#fcc" : "#cfc"}`,
    }}>
      {error ? (
        <>
          <p style={{ color: "#dc2626", fontWeight: "bold", margin: 0 }}>Error</p>
          <p style={{ fontFamily: "monospace", fontSize: "0.85rem", margin: "0.5rem 0 0" }}>{error}</p>
        </>
      ) : data ? (
        <>
          <p style={{ color: "#16a34a", fontWeight: "bold", margin: 0 }}>OK</p>
          <p style={{ fontFamily: "monospace", fontSize: "0.85rem", margin: "0.5rem 0 0" }}>
            Value: {data.value} | Generated: {data.generated}
          </p>
        </>
      ) : (
        <p style={{ color: "#888", margin: 0 }}>No data</p>
      )}
    </div>
  );
}

export default function ReconnectPage() {
  const hasRedis = !!process.env.REDIS_URL;

  return (
    <div>
      <h1>C3. Reconnection Recovery</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Manually tests whether the cache operates normally after a Redis connection is lost and restored.
      </p>

      {!hasRedis && (
        <div style={{
          padding: "1rem",
          background: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: 8,
          marginBottom: "1rem",
        }}>
          <p style={{ margin: 0, fontWeight: "bold", color: "#92400e" }}>Redis not connected</p>
          <p style={{ margin: "0.5rem 0 0", color: "#78716c", fontSize: "0.9rem" }}>
            This test requires a Redis connection to observe disconnect/reconnect behavior.
            Without Redis, the page renders normally using in-memory cache.
          </p>
        </div>
      )}

      <Suspense fallback={<p style={{ color: "#888" }}>Loading cache data...</p>}>
        <ReconnectContent />
      </Suspense>

      <div style={{ padding: "1rem", background: "#f0f8ff", borderRadius: 8, fontSize: "0.9rem" }}>
        <strong>Test Steps (requires Redis):</strong>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li>Verify this page loads normally (status above: OK)</li>
          <li>Disconnect Redis (stop the server or kill port-forward)</li>
          <li>Refresh this page → check for error or fallback behavior</li>
          <li>Reconnect Redis</li>
          <li>Refresh this page → verify normal operation restored</li>
        </ol>
      </div>

      <div style={{ padding: "1rem", background: "#fff8f0", borderRadius: 8, fontSize: "0.9rem", marginTop: "1rem" }}>
        <strong>Checkpoints:</strong>
        <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li>When Redis is disconnected: Next.js renders without cache (graceful degradation)</li>
          <li>After reconnection: @redis/client auto-reconnects → cache operates normally</li>
          <li>Verify recovery after &quot;Connection timeout&quot; logs in the console</li>
        </ul>
      </div>
    </div>
  );
}
