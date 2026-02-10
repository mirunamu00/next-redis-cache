"use client";

import { useEffect, useState, useCallback } from "react";

interface CacheEntry {
  key: string;
  handler: string;
  size: number;
  ttl: number;
  tags: string[];
  storedAt: string;
}

export function CacheViewer() {
  const [entries, setEntries] = useState<CacheEntry[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState<unknown>(null);
  const [loadingValue, setLoadingValue] = useState(false);

  const fetchEntries = useCallback(async () => {
    if (document.hidden) return;
    try {
      const res = await fetch("/api/cache-store");
      const data = await res.json();
      setEntries(data.entries ?? []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchEntries();
    const interval = setInterval(fetchEntries, 3000);
    const onVisibilityChange = () => {
      if (!document.hidden) fetchEntries();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetchEntries]);

  const handleKeyClick = async (key: string) => {
    if (expandedKey === key) {
      setExpandedKey(null);
      setKeyValue(null);
      return;
    }
    setExpandedKey(key);
    setLoadingValue(true);
    try {
      const res = await fetch(`/api/cache-store?key=${encodeURIComponent(key)}`);
      const data = await res.json();
      setKeyValue(data.value);
    } catch {
      setKeyValue("(failed to load)");
    } finally {
      setLoadingValue(false);
    }
  };

  const formatSize = (size: number) => {
    if (size < 1024) return `${size}B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
    return `${(size / 1024 / 1024).toFixed(1)}MB`;
  };

  const handlerColor = (h: string) => {
    if (h === "legacy") return "#f59e0b";
    if (h === "use-cache") return "#8b5cf6";
    return "#888";
  };

  return (
    <div
      style={{
        borderTop: "1px solid #e0e0e0",
        background: "#1e1e1e",
        color: "#d4d4d4",
        fontSize: "0.8rem",
        fontFamily: "monospace",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 12px",
          background: "#2d2d2d",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ fontWeight: "bold" }}>
          Cached Data ({entries.length}) {expanded ? "▼" : "▲"}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              fetchEntries();
            }}
            style={{
              padding: "2px 8px",
              background: "#444",
              color: "#ccc",
              border: "1px solid #555",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: "0.75rem",
            }}
          >
            Refresh
          </button>
          <button
            onClick={async (e) => {
              e.stopPropagation();
              await fetch("/api/cache-store", { method: "DELETE" });
              setEntries([]);
              setExpandedKey(null);
              setKeyValue(null);
            }}
            style={{
              padding: "2px 8px",
              background: "#5a2020",
              color: "#f87171",
              border: "1px solid #7f1d1d",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: "0.75rem",
            }}
          >
            Clear
          </button>
        </div>
      </div>
      {expanded && (
        <div style={{ height: 300, overflowY: "auto", overflowX: "hidden", padding: "4px 12px" }}>
          {entries.length === 0 ? (
            <div style={{ color: "#666", padding: "8px 0" }}>No cached data yet. Visit a test page to generate cache entries.</div>
          ) : (
            entries.map((e) => (
              <div key={e.key}>
                <div
                  style={{
                    padding: "3px 0",
                    borderBottom: "1px solid #333",
                    cursor: "pointer",
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                  }}
                  onClick={() => handleKeyClick(e.key)}
                >
                  <span style={{ color: "#888" }}>
                    {expandedKey === e.key ? "▾" : "▸"}
                  </span>
                  <span
                    style={{
                      color: handlerColor(e.handler),
                      fontSize: "0.7rem",
                      padding: "0 4px",
                      background: "#333",
                      borderRadius: 3,
                      flexShrink: 0,
                    }}
                  >
                    {e.handler}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {e.key}
                  </span>
                  <span style={{ color: "#888", flexShrink: 0 }}>
                    {formatSize(e.size)}
                  </span>
                </div>
                {expandedKey === e.key && (
                  <div
                    style={{
                      padding: "6px 12px 6px 24px",
                      background: "#252525",
                      borderBottom: "1px solid #333",
                    }}
                  >
                    {loadingValue ? (
                      <span style={{ color: "#888" }}>Loading...</span>
                    ) : (
                      <>
                        <div style={{ color: "#888", marginBottom: 4, fontSize: "0.75rem" }}>
                          {e.tags.length > 0 && (
                            <span>tags: {e.tags.map((t) => (
                              <span key={t} style={{ color: "#4ade80", background: "#1a3a1a", padding: "0 3px", borderRadius: 2, marginRight: 4 }}>{t}</span>
                            ))}</span>
                          )}
                          {e.ttl > 0 && <span style={{ marginLeft: 8 }}>ttl: {e.ttl}s</span>}
                          <span style={{ marginLeft: 8 }}>stored: {e.storedAt.split("T")[1]?.slice(0, 8)}</span>
                        </div>
                        <pre
                          style={{
                            margin: 0,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-all",
                            fontSize: "0.75rem",
                            color: "#9cdcfe",
                            maxHeight: 200,
                            overflowY: "auto",
                          }}
                        >
                          {typeof keyValue === "string"
                            ? keyValue
                            : JSON.stringify(keyValue, null, 2)}
                        </pre>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
