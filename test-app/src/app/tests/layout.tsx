import { CacheViewer } from "./cache-viewer";

const navItems = [
  { label: 'A. "use cache"', items: [
    { id: "A1", label: "Basic", href: "/tests/use-cache/basic" },
    { id: "A2", label: "cacheLife", href: "/tests/use-cache/cache-life" },
    { id: "A3", label: "cacheTag", href: "/tests/use-cache/cache-tag" },
    { id: "A4", label: "Component", href: "/tests/use-cache/component" },
    { id: "A5", label: "Nested", href: "/tests/use-cache/nested" },
  ]},
  { label: "B. Legacy Fetch", items: [
    { id: "B1", label: "Basic fetch", href: "/tests/legacy/basic-fetch" },
    { id: "B2", label: "fetch+tags", href: "/tests/legacy/fetch-tags" },
    { id: "B3", label: "Multi tags", href: "/tests/legacy/multi-tags" },
    { id: "B4", label: "revalidatePath", href: "/tests/legacy/revalidate-path" },
  ]},
  { label: "C. Cross-cutting", items: [
    { id: "C1", label: "Prewarm", href: "/tests/cross/prewarm" },
    { id: "C2", label: "Cleanup", href: "/tests/cross/cleanup" },
    { id: "C3", label: "Reconnect", href: "/tests/cross/reconnect" },
    { id: "C4", label: "Concurrent", href: "/tests/cross/concurrent" },
    { id: "C5", label: "TTL Expiry", href: "/tests/cross/ttl-expiry" },
  ]},
];

export default function TestsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", fontFamily: "system-ui", minHeight: "100vh", maxWidth: "100vw", overflow: "hidden" }}>
      {/* Sidebar */}
      <nav style={{
        width: 220,
        padding: "1rem",
        background: "#f8f9fa",
        borderRight: "1px solid #e0e0e0",
        fontSize: "0.85rem",
        flexShrink: 0,
        overflowY: "auto",
      }}>
        <a href="/" style={{ display: "block", marginBottom: "1rem", color: "#333", fontWeight: "bold", textDecoration: "none" }}>
          ← Dashboard
        </a>
        {navItems.map((group) => (
          <div key={group.label} style={{ marginBottom: "1rem" }}>
            <div style={{ fontWeight: "bold", color: "#555", marginBottom: "0.3rem", fontSize: "0.8rem" }}>
              {group.label}
            </div>
            {group.items.map((item) => (
              <a
                key={item.id}
                href={item.href}
                style={{
                  display: "block",
                  padding: "3px 8px",
                  color: "#0070f3",
                  textDecoration: "none",
                  borderRadius: 4,
                }}
              >
                {item.id} {item.label}
              </a>
            ))}
          </div>
        ))}
      </nav>

      {/* Main content + Log viewer */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, padding: "1.5rem", overflowY: "auto", overflowX: "hidden" }}>
          {children}
        </div>
        <CacheViewer />
      </div>
    </div>
  );
}
