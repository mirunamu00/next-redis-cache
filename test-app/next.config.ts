import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheHandler: require.resolve("./cache-handler.mjs"),
  cacheHandlers: {
    default: require.resolve("./use-cache-handler.mjs"),
  },
  cacheMaxMemorySize: 0,
  generateBuildId: async () => process.env.BUILD_ID || "test-default",
  cacheComponents: true,
};

export default nextConfig;
