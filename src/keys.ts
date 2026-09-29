/**
 * Key layout (ROADMAP.md section 5.1):
 *
 *   {ns}:{buildId}:e:{cacheKey}   legacy entry (String, binary envelope, always a TTL)
 *   {ns}:{buildId}:u:{cacheKey}   "use cache" entry (String, binary envelope, always a TTL)
 *   {ns}:_tagstate                tag state of every build (Hash, no TTL)
 *   {ns}:_builds                  build registry (ZSET buildId -> last start, no TTL)
 *
 * The second segment is the owner: a build id, or a reserved name starting with "_" that old-build
 * cleanup never touches. 1.x keys laid out as `{ns}:{buildId}:{cacheKey}` have the same owner segment,
 * so the same cleanup removes them.
 */
export const TAG_STATE_OWNER = "_tagstate";
export const REGISTRY_OWNER = "_builds";

export const entryKey = (namespace: string, buildId: string, cacheKey: string) => `${namespace}:${buildId}:e:${cacheKey}`;
export const useCacheKey = (namespace: string, buildId: string, cacheKey: string) => `${namespace}:${buildId}:u:${cacheKey}`;
export const tagStateKey = (namespace: string) => `${namespace}:${TAG_STATE_OWNER}`;
export const registryKey = (namespace: string) => `${namespace}:${REGISTRY_OWNER}`;

/** Owner segment of a key inside `namespace` (build id, or a reserved "_" name). */
export function ownerOf(namespace: string, key: string): string {
  const rest = key.slice(namespace.length + 1);
  const end = rest.indexOf(":");
  return end < 0 ? rest : rest.slice(0, end);
}

export const isReservedOwner = (owner: string) => owner.startsWith("_");

/** Escapes glob metacharacters for SCAN MATCH. */
export function escapeGlob(value: string): string {
  return value.replace(/[*?[\]\\]/g, "\\$&");
}
