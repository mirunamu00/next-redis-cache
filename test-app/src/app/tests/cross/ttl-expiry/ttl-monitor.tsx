"use client";

import { useEffect, useState } from "react";

export function TtlMonitor({ generatedAt }: { generatedAt: string }) {
  const [elapsed, setElapsed] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const generatedTime = new Date(generatedAt).getTime();

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - generatedTime) / 1000));
    }, 500);
    return () => clearInterval(interval);
  }, [generatedTime]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      window.location.reload();
    }, 2000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  const getPhase = () => {
    if (elapsed <= 3) return { label: "Fresh", color: "#16a34a" };
    if (elapsed <= 5) return { label: "Stale (revalidating)", color: "#f59e0b" };
    if (elapsed <= 10) return { label: "Stale (expiring soon)", color: "#dc2626" };
    return { label: "Expired", color: "#7c3aed" };
  };

  const phase = getPhase();

  return (
    <div style={{
      padding: "1rem",
      background: "#f8f8f8",
      borderRadius: 8,
      marginBottom: "1rem",
      border: `2px solid ${phase.color}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <span style={{ fontSize: "2rem", fontWeight: "bold", fontFamily: "monospace" }}>
            {elapsed}s
          </span>
          <span style={{ marginLeft: "1rem", color: phase.color, fontWeight: "bold" }}>
            {phase.label}
          </span>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh (2s)
        </label>
      </div>

      <div style={{
        marginTop: "0.5rem",
        height: 8,
        background: "#e0e0e0",
        borderRadius: 4,
        overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width: `${Math.min(100, (elapsed / 10) * 100)}%`,
          background: phase.color,
          transition: "width 0.5s, background 0.5s",
          borderRadius: 4,
        }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#888", marginTop: "0.25rem" }}>
        <span>0s (fresh)</span>
        <span>3s (stale)</span>
        <span>5s (revalidate)</span>
        <span>10s (expire)</span>
      </div>
    </div>
  );
}
