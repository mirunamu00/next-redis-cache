// Tests for the "no Hangul in code" gate rules.
// Hangul samples are built from code points so this file itself stays free of Hangul.
import { describe, expect, it } from "vitest";
import { findHangulLines, HANGUL_RANGES, isChecked } from "../../scripts/lib/hangul-rules.mjs";

const cp = (n: number) => String.fromCodePoint(n);

describe("isChecked", () => {
  it("checks code and config files", () => {
    for (const f of ["src/index.ts", "scripts/infra.mjs", ".github/workflows/ci.yml", "docker/compose.yml", "package.json"]) {
      expect(isChecked(f)).toBe(true);
    }
  });

  it("exempts Markdown documents", () => {
    for (const f of ["ROADMAP.md", "README.md", "CHANGELOG.md", ".changeset/README.md", "docs/Guide.MD"]) {
      expect(isChecked(f)).toBe(false);
    }
  });
});

describe("findHangulLines", () => {
  it("reports 1-based line numbers of lines containing Hangul", () => {
    const text = ["const a = 1;", `// ${cp(0xac00)}${cp(0xb098)}`, "ok", `x = "${cp(0xd7a3)}"`].join("\n");
    expect(findHangulLines(text).map((h) => h.line)).toEqual([2, 4]);
  });

  it("detects the first and last code point of every range (Jamo, Compatibility Jamo, Syllables)", () => {
    for (const [lo, hi] of HANGUL_RANGES) {
      expect(findHangulLines(cp(lo))).toHaveLength(1);
      expect(findHangulLines(cp(hi))).toHaveLength(1);
    }
  });

  it("ignores ASCII, other CJK and code points just outside the ranges", () => {
    const text = ["plain ascii", `${cp(0x65e5)}${cp(0x672c)}`, cp(0x10ff), cp(0x1200), cp(0x312f), cp(0x3190), cp(0xabff), cp(0xd7b0)].join(
      "\r\n",
    );
    expect(findHangulLines(text)).toEqual([]);
  });
});
