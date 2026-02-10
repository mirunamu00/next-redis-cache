import { ConcurrentTester } from "./concurrent-tester";

export default function ConcurrentPage() {
  return (
    <div>
      <h1>C4. Concurrent Requests</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Tests whether the pendingSets mechanism works when concurrent requests hit the same cache key.
      </p>

      <ConcurrentTester />

      <div style={{ padding: "1rem", background: "#f0f8ff", borderRadius: 8, fontSize: "0.9rem", marginTop: "1rem" }}>
        <strong>Verification:</strong>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li>Click &quot;Flush Redis keys&quot; then &quot;Send 5 concurrent requests&quot;</li>
          <li>Check in the logs below that only 1 set occurred for the same key</li>
          <li>Remaining requests are resolved via pendingSets as get operations</li>
          <li>All responses should return the same cached value</li>
        </ol>
      </div>
    </div>
  );
}
