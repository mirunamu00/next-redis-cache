// Rules for the "no Hangul in code" gate. Shared by scripts/check-no-hangul.mjs and its unit test.
//
// Policy: every non-Markdown file in the repository (source, tests, scripts, configs, workflows)
// must be free of Hangul. Markdown documents (ROADMAP.md, README.md, CHANGELOG.md, ...) are exempt.

/** Hangul Jamo (U+1100-U+11FF), Compatibility Jamo (U+3130-U+318F), Syllables (U+AC00-U+D7AF). */
export const HANGUL_RANGES = [
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
  [0xac00, 0xd7af],
];

// Built from code points so this file itself never contains a literal Hangul character.
const charClass = HANGUL_RANGES.map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join("");
export const HANGUL_RE = new RegExp(`[${charClass}]`);

/**
 * Whether a repository-relative path is subject to the gate.
 * @param {string} file forward-slash path relative to the repo root
 */
export function isChecked(file) {
  return !/\.md$/i.test(file);
}

/**
 * Finds lines that contain Hangul.
 * @param {string} text file content
 * @returns {{ line: number, text: string }[]} 1-based line numbers
 */
export function findHangulLines(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (HANGUL_RE.test(lines[i])) hits.push({ line: i + 1, text: lines[i].trim() });
  }
  return hits;
}
