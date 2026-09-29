import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>full-cc</h1>
      <p id="page">home</p>
      <Link href="/uc/1">uc 1</Link> <Link href="/short">short</Link> <Link href="/remote">remote</Link> <Link href="/ppr">ppr</Link>
    </main>
  );
}
