// Runs every available test layer against local infrastructure:
//   infra:up (redis84 + toxiproxy) -> all vitest projects -> infra:down (always, unless --keep-infra)
// Usage: npm run test:all [-- --keep-infra]
// Layers added in later stages (contract, e2e, chaos, perf) are appended here as they land.
import { fileURLToPath } from "node:url";
import { run } from "./lib/run.mjs";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const keepInfra = process.argv.includes("--keep-infra");
const PROJECTS = ["unit", "property", "fault", "fault-docker", "integration"];

let status = run("node", ["scripts/infra.mjs", "up", "redis84", "toxiproxy"], { shell: false }).status;
if (status === 0) {
  status = run("npx", ["vitest", "run", ...PROJECTS.flatMap((p) => ["--project", p])]).status;
} else {
  console.error("[test-all] infra:up failed; tests were not run");
}

if (!keepInfra) {
  const down = run("node", ["scripts/infra.mjs", "down"], { shell: false }).status;
  if (down !== 0) console.error("[test-all] infra:down failed; run `npm run infra:down` manually");
}

process.exit(status);
