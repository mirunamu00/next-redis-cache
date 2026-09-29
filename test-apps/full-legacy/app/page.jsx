import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>full-legacy</h1>
      <p id="page">home</p>
      <Link href="/isr/1">isr 1</Link> <Link href="/pinned/1">pinned 1</Link> <Link href="/fetch-tags">fetch-tags</Link>
    </main>
  );
}
