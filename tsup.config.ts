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
  // Build-only config that sees src/ only, so tests and config files never leak into the .d.ts output
  tsconfig: "tsconfig.build.json",
  target: "node18",
  external: ["next", "@redis/client"],
  treeshake: true,
});
