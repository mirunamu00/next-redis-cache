// Nested layout inside a route group, like the docs app.
export default function DocsLayout({ children }) {
  return (
    <div className="docs-shell">
      <nav id="docs-nav">docs</nav>
      {children}
    </div>
  );
}
