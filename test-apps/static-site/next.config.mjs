// static-site: the docs.mirunamu.info pattern (ROADMAP.md section 6.3). Legacy cache only.
import { fileURLToPath } from "node:url";
import { testAppConfig } from "./_shared/next-config.mjs";

export default testAppConfig(fileURLToPath(new URL(".", import.meta.url)));
