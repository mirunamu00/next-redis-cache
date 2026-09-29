// full-legacy: every legacy cache path with cacheComponents off (ROADMAP.md section 6.3).
import { fileURLToPath } from "node:url";
import { testAppConfig } from "./_shared/next-config.mjs";

export default testAppConfig(fileURLToPath(new URL(".", import.meta.url)));
