// full-cc: "use cache" paths with cacheComponents on (ROADMAP.md section 6.3).
// Custom profile `short` exercises time-based SWR quickly: revalidate 2s, expire 10s.
import { fileURLToPath } from "node:url";
import { testAppConfig } from "./_shared/next-config.mjs";

export default testAppConfig(fileURLToPath(new URL(".", import.meta.url)), {
  cacheComponents: true,
  cacheLife: {
    short: { stale: 1, revalidate: 2, expire: 10 },
  },
});
