/**
 * Redis versions under test. NRC_REDIS_VERSIONS is a comma separated list (default: every supported
 * version); CI sets one version per matrix cell.
 */

/** 8.4 = current production, 7.2 = lower bound without HEXPIRE. */
export const SUPPORTED_REDIS_VERSIONS = ["8.4", "7.2"] as const;

export function redisVersionsUnderTest(): string[] {
  const raw = process.env.NRC_REDIS_VERSIONS?.trim();
  if (!raw) return [...SUPPORTED_REDIS_VERSIONS];
  const versions = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const unknown = versions.filter((v) => !(SUPPORTED_REDIS_VERSIONS as readonly string[]).includes(v));
  if (unknown.length > 0) {
    throw new Error(`NRC_REDIS_VERSIONS has unsupported version(s): ${unknown.join(", ")}`);
  }
  return versions;
}
