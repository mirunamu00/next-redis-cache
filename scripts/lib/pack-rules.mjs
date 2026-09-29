// Validation rules for the npm tarball. Shared by scripts/check-pack.mjs and its unit test.
//
// Policy (ROADMAP.md section 6.1): the tarball contains dist/ plus the metadata files npm adds
// automatically. Any test asset (tests/, test-apps/, docker/, scripts/, ROADMAP.md, ...) must fail the gate.

/** Files allowed in the tarball. */
const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^dist\/[^/]+\.(?:js|cjs|mjs|d\.ts|d\.cts|d\.mts|map)$/,
];

/** Metadata files that must be present. */
const REQUIRED = ["package.json", "README.md", "LICENSE"];

/**
 * Collects the file paths referenced by exports, main, module and types in package.json.
 * @param {Record<string, unknown>} pkg
 * @returns {string[]} paths without the leading "./"
 */
export function exportTargets(pkg) {
  const targets = new Set();
  const visit = (node) => {
    if (typeof node === "string") targets.add(node.replace(/^\.\//, ""));
    else if (node && typeof node === "object") for (const v of Object.values(node)) visit(v);
  };
  visit(pkg.exports);
  for (const field of ["main", "module", "types"]) visit(pkg[field]);
  return [...targets].sort();
}

/**
 * Checks a tarball file list against the rules.
 * @param {string[]} files files[].path from `npm pack --json`
 * @param {Record<string, unknown>} pkg package.json
 * @returns {{ ok: boolean, unexpected: string[], missing: string[] }}
 */
export function validatePackFiles(files, pkg) {
  const set = new Set(files);
  const unexpected = files.filter((f) => !ALLOWED.some((re) => re.test(f))).sort();
  const missing = [...REQUIRED, ...exportTargets(pkg)].filter((f) => !set.has(f)).sort();
  return { ok: unexpected.length === 0 && missing.length === 0, unexpected, missing };
}
