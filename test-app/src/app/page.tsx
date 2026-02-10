import { DashboardActions } from "./dashboard-actions";

const tests = [
  {
    category: 'A. "use cache" Handlers',
    items: [
      { id: "A1", name: "Basic use cache", path: "/tests/use-cache/basic", desc: "Function result caching, HIT on revisit" },
      { id: "A2", name: "cacheLife Profiles", path: "/tests/use-cache/cache-life", desc: "TTL differences per profile (seconds/minutes/hours)" },
      { id: "A3", name: "cacheTag + revalidateTag", path: "/tests/use-cache/cache-tag", desc: "Tag-based on-demand invalidation" },
      { id: "A4", name: "Component Caching", path: "/tests/use-cache/component", desc: "page-level use cache + cacheLife" },
      { id: "A5", name: "Nested Cache Functions", path: "/tests/use-cache/nested", desc: "Parent/child functions cached independently" },
    ],
  },
  {
    category: "B. Legacy Fetch Handler",
    items: [
      { id: "B1", name: "Basic Fetch Cache", path: "/tests/legacy/basic-fetch", desc: "fetch(url, {next:{revalidate}}) → set/get" },
      { id: "B2", name: "fetch + tags", path: "/tests/legacy/fetch-tags", desc: "fetch(url, {next:{tags}}) → Tag registration" },
      { id: "B3", name: "Multi-tag Revalidate", path: "/tests/legacy/multi-tags", desc: "Behavior when only one of multiple tags is invalidated" },
      { id: "B4", name: "revalidatePath", path: "/tests/legacy/revalidate-path", desc: "Path-based invalidation" },
    ],
  },
  {
    category: "C. Cross-cutting",
    items: [
      { id: "C1", name: "Prewarm Check", path: "/tests/cross/prewarm", desc: "registerInitialCache → Build artifacts loaded into Redis" },
      { id: "C2", name: "Build Key Cleanup", path: "/tests/cross/cleanup", desc: "cleanupOldBuildKeys → Previous build keys deleted" },
      { id: "C3", name: "Redis Reconnection", path: "/tests/cross/reconnect", desc: "Behavior on Redis disconnect/reconnect" },
      { id: "C4", name: "Concurrent Requests", path: "/tests/cross/concurrent", desc: "Concurrent set on same key → pendingSets wait" },
      { id: "C5", name: "TTL Expiry", path: "/tests/cross/ttl-expiry", desc: "Verify expiry after short TTL" },
    ],
  },
];

const buildId = process.env.BUILD_ID || "test-default";

export default function Dashboard() {
  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 900, margin: "0 auto", padding: "2rem" }}>
      <h1 style={{ fontSize: "1.8rem", marginBottom: "0.5rem" }}>
        @mirunamu/cache-handler Test Dashboard
      </h1>
      <p style={{ color: "#666", marginBottom: "1.5rem" }}>
        Build ID: <code>{buildId}</code> &nbsp;|&nbsp; Redis: <code>{process.env.REDIS_URL ?? "not set"}</code>
      </p>

      <DashboardActions />

      {tests.map((group) => (
        <section key={group.category} style={{ marginBottom: "2rem" }}>
          <h2 style={{ fontSize: "1.2rem", borderBottom: "2px solid #eee", paddingBottom: "0.5rem" }}>
            {group.category}
          </h2>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.5rem" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: "6px 8px", width: 40 }}>#</th>
                <th style={{ padding: "6px 8px" }}>Test</th>
                <th style={{ padding: "6px 8px" }}>Verification Point</th>
              </tr>
            </thead>
            <tbody>
              {group.items.map((t) => (
                <tr key={t.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <td style={{ padding: "6px 8px", fontWeight: "bold", color: "#666" }}>{t.id}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <a href={t.path} style={{ color: "#0070f3", textDecoration: "none" }}>
                      {t.name}
                    </a>
                  </td>
                  <td style={{ padding: "6px 8px", color: "#888", fontSize: "0.9rem" }}>{t.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <section style={{ marginTop: "2rem", padding: "1rem", background: "#f8f8f8", borderRadius: 8 }}>
        <h3 style={{ margin: "0 0 0.5rem" }}>Debug APIs</h3>
        <ul style={{ margin: 0, paddingLeft: "1.5rem", fontSize: "0.9rem" }}>
          <li><a href="/api/cache-store">/api/cache-store</a> — In-memory cache data viewer</li>
        </ul>
      </section>
    </main>
  );
}
