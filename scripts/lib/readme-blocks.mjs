// Extracts the README code blocks that are complete files (first line `// <relative path>` ending in
// .js, .mjs, .ts or .mts), so scripts/contract-types.mjs can type-check them against the published
// package like a consumer's project (ROADMAP.md 7-13: the README must not document an API that does
// not exist).
const FENCE = /```(?:js|ts|mjs|javascript|typescript)\n([\s\S]*?)```/g;
const FILE_LINE = /^\/\/ ((?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|ts|mts))\s*$/;

/** @returns {Array<{ file: string, code: string }>} */
export function readmeFiles(markdown) {
  const files = [];
  for (const m of markdown.matchAll(FENCE)) {
    const code = m[1];
    const first = code.split("\n", 1)[0];
    const file = FILE_LINE.exec(first)?.[1];
    if (file && !file.includes("..")) files.push({ file, code });
  }
  return files;
}
