"use client";

import { useState } from "react";

interface RequestResult {
  index: number;
  status: number;
  durationMs: number;
  body: string;
}

export function ConcurrentTester() {
  const [results, setResults] = useState<RequestResult[]>([]);
  const [loading, setLoading] = useState(false);

  async function runConcurrentRequests() {
    setLoading(true);
    setResults([]);

    // Send 5 concurrent requests to a cached page
    const promises = Array.from({ length: 5 }, (_, i) =>
      (async () => {
        const t0 = performance.now();
        const res = await fetch("/tests/use-cache/basic", { cache: "no-store" });
        const body = await res.text();
        const durationMs = Math.round(performance.now() - t0);
        return {
          index: i + 1,
          status: res.status,
          durationMs,
          body: body.slice(0, 100) + "...",
        };
      })()
    );

    const allResults = await Promise.all(promises);
    setResults(allResults);
    setLoading(false);
  }

  return (
    <div>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button
          onClick={runConcurrentRequests}
          disabled={loading}
          style={{
            padding: "8px 16px",
            background: loading ? "#ccc" : "#0070f3",
            color: "white",
            border: "none",
            borderRadius: 6,
            cursor: loading ? "default" : "pointer",
            fontSize: "0.9rem",
          }}
        >
          {loading ? "Requesting..." : "Send 5 concurrent requests"}
        </button>
      </div>

      {results.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "1rem" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #ddd" }}>
              <th style={{ padding: "6px 12px", textAlign: "left" }}>#</th>
              <th style={{ padding: "6px 12px", textAlign: "left" }}>Status</th>
              <th style={{ padding: "6px 12px", textAlign: "left" }}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.index} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "6px 12px" }}>Request {r.index}</td>
                <td style={{ padding: "6px 12px" }}>
                  <span style={{ color: r.status === 200 ? "#16a34a" : "#dc2626" }}>
                    {r.status}
                  </span>
                </td>
                <td style={{ padding: "6px 12px", fontFamily: "monospace" }}>{r.durationMs}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ padding: "1rem", background: "#f0f9ff", borderRadius: 8, fontSize: "0.85rem" }}>
        <strong>What to observe:</strong> Check the Cached Data panel below — after 5 concurrent requests,
        you should see the cache entry was written once. All 5 requests should return 200.
      </div>
    </div>
  );
}
