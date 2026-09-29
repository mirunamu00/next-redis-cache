import Link from "next/link";
import { allSlugs, slugKey } from "../lib/content.mjs";

export default function Home() {
  return (
    <main>
      <h1>static-site</h1>
      <p id="page">home</p>
      <ul>
        {allSlugs().slice(0, 10).map((s) => (
          <li key={slugKey(s)}>
            <Link href={`/docs/${slugKey(s)}`}>{slugKey(s)}</Link>
          </li>
        ))}
      </ul>
      <Link href="/about">about</Link>
    </main>
  );
}
