"use client";

import { useState } from "react";

export function DashboardActions() {
  const [status, setStatus] = useState("");

  async function clearCache() {
    setStatus("Clearing cache store...");
    // The cache store is in-memory, just viewing data
    // Clearing it would require a server restart
    setStatus("Cache store is in-memory and reflects server state.");
    setTimeout(() => setStatus(""), 3000);
  }

  return (
    <div style={{ marginBottom: "1.5rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
      <button
        onClick={clearCache}
        style={{
          padding: "6px 16px",
          background: "#f5f5f5",
          border: "1px solid #ddd",
          borderRadius: 6,
          cursor: "pointer",
          fontSize: "0.85rem",
        }}
      >
        Cache Info
      </button>
      {status && (
        <span style={{ fontSize: "0.85rem", color: "#666" }}>{status}</span>
      )}
    </div>
  );
}
