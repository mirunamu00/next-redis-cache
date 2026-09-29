// Runs every available test layer against local infrastructure:
//   infra:up (redis84 + toxiproxy) -> all vitest projects -> infra:down (always, unless --keep-infra)
// Usage: npm run test:all [-- --keep-infra]
// Covers every vitest layer except chaos (see PROJECTS).
import { fileURLToPath } from "node:url";
import { run } from "./lib/run.mjs";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const keepInfra = process.argv.includes("--keep-infra");
// e2e, chaos and perf need app builds (scripts/prepare-app.mjs) and run separately (npm run test:e2e / test:chaos / test:perf)
const PROJECTS = ["unit", "property", "contract", "fault", "fault-docker", "integration"];

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
