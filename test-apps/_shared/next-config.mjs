// Base next.config shared by every test app (ROADMAP.md section 6.3).
// The app directory is passed in so tracing and Turbopack never climb up to the repository root
// (the repo has its own package-lock.json, which Next would otherwise pick as the workspace root).
import path from "node:path";

export function testAppConfig(appDir, extra = {}) {
  const handler = (file) => path.join(appDir, "_shared", file);
  return {
    output: "standalone",
    outputFileTracingRoot: appDir,
    outputFileTracingIncludes: { "/*": ["./_shared/**/*"] },
    turbopack: { root: appDir },
    generateBuildId: async () => process.env.BUILD_ID || "default",
    cacheMaxMemorySize: 0,
    cacheHandler: handler("cache-handler.mjs"),
    cacheHandlers: {
      default: handler("use-cache-handler.mjs"),
      remote: handler("use-cache-handler.mjs"),
    },
    images: { unoptimized: true },
    reactStrictMode: false,
    poweredByHeader: false,
    ...extra,
  };
}
