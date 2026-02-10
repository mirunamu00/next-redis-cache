import { Suspense } from "react";

async function getData() {
  try {
    const res = await fetch("https://worldtimeapi.org/api/timezone/Etc/UTC", {
      next: { revalidate: 300 },
    });
    if (!res.ok) return { datetime: new Date().toISOString(), fallback: true };
    const data = await res.json();
    return { datetime: data.datetime as string, fallback: false };
  } catch {
    return { datetime: new Date().toISOString(), fallback: true };
  }
}

async function PathContent() {
  const data = await getData();
  return (
    <>
      <table style={{ borderCollapse: "collapse", marginBottom: "1rem" }}>
        <tbody>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>UTC time</td>
            <td style={{ padding: "4px 12px", fontFamily: "monospace" }}>{data.datetime}</td>
          </tr>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Fallback</td>
            <td style={{ padding: "4px 12px" }}>{data.fallback ? "Yes" : "No"}</td>
          </tr>
          <tr>
            <td style={{ padding: "4px 12px", fontWeight: "bold" }}>Revalidate</td>
            <td style={{ padding: "4px 12px" }}>300s (5 min)</td>
          </tr>
        </tbody>
      </table>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <a
          href="/api/revalidate?path=/tests/legacy/revalidate-path&redirect=/tests/legacy/revalidate-path"
          style={{ display: "inline-block", padding: "8px 16px", background: "#7c3aed", color: "white", borderRadius: 6, textDecoration: "none", fontSize: "0.9rem" }}
        >
          revalidatePath(&quot;/tests/legacy/revalidate-path&quot;)
        </a>
      </div>
    </>
  );
}

export default function RevalidatePathPage() {
  return (
    <div>
      <h1>B4. revalidatePath</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Tests path-based invalidation (<code>revalidatePath</code>) without tags.
      </p>

      <Suspense fallback={<p style={{ color: "#888" }}>Loading data...</p>}>
        <PathContent />
      </Suspense>

      <div style={{ padding: "1rem", background: "#fff8f0", borderRadius: 8, fontSize: "0.9rem" }}>
        <strong>Verification:</strong>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.5rem" }}>
          <li>First visit: Check current value</li>
          <li>Refresh: Same value (HIT)</li>
          <li>Button click: Path-based invalidation → Value updated</li>
          <li>Verify that invalidation works via path even without tags</li>
        </ol>
      </div>
    </div>
  );
}
