// Tests for the publish isolation gate itself: it must fail when test assets leak in or required files are missing.
import { describe, expect, it } from "vitest";
import { exportTargets, validatePackFiles } from "../../scripts/lib/pack-rules.mjs";

const pkg = {
  main: "./dist/index.cjs",
  module: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js", require: "./dist/index.cjs" },
    "./use-cache": { types: "./dist/use-cache.d.ts", import: "./dist/use-cache.js", require: "./dist/use-cache.cjs" },
  },
};

const good = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/index.js",
  "dist/index.cjs",
  "dist/index.d.ts",
  "dist/index.d.cts",
  "dist/use-cache.js",
  "dist/use-cache.cjs",
  "dist/use-cache.d.ts",
  "dist/chunk-ABC.js",
];

describe("exportTargets", () => {
  it("collects exports/main/module/types file paths without duplicates", () => {
    expect(exportTargets(pkg)).toEqual([
      "dist/index.cjs",
      "dist/index.d.ts",
      "dist/index.js",
      "dist/use-cache.cjs",
      "dist/use-cache.d.ts",
      "dist/use-cache.js",
    ]);
  });
});

describe("validatePackFiles", () => {
  it("passes with only dist and metadata files", () => {
    expect(validatePackFiles(good, pkg)).toEqual({ ok: true, unexpected: [], missing: [] });
  });

  it("fails when test assets or docs leak in", () => {
    const result = validatePackFiles(
      [...good, "tests/unit/a.test.ts", "test-apps/static-site/package.json", "ROADMAP.md", "docker/compose.yml", "dist/nested/x.js"],
      pkg,
    );
    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual([
      "ROADMAP.md",
      "dist/nested/x.js",
      "docker/compose.yml",
      "test-apps/static-site/package.json",
      "tests/unit/a.test.ts",
    ]);
  });

  it("fails when LICENSE or an exports target is missing", () => {
    const result = validatePackFiles(good.filter((f) => f !== "LICENSE" && f !== "dist/use-cache.cjs"), pkg);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["LICENSE", "dist/use-cache.cjs"]);
  });
});
