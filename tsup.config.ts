import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "use-cache": "src/use-cache.ts",
    instrumentation: "src/instrumentation.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  clean: true,
  outDir: "dist",
  target: "node18",
  external: ["next", "@redis/client"],
  treeshake: true,
});
