// Test infrastructure manager for docker/compose.yml (ROADMAP.md section 6.4).
//
// Usage (via npm scripts):
//   npm run infra:up                    start the default profiles: redis84, redis72, toxiproxy
//   npm run infra:up -- prodlike        start specific profiles (redis84 redis72 prodlike toxiproxy replica, or "all")
//   npm run infra:down                  stop every profile and delete volumes
//   npm run infra:ps                    list containers
//   npm run infra:logs -- [service]     print recent logs
//   npm run infra:cli -- [service] [redis-cli args...]   open redis-cli (default service redis84)
//
// Works on Windows (Docker Desktop, WSL2) and Linux. Requires Docker Compose v2.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run } from "./lib/run.mjs";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const COMPOSE_FILE = "docker/compose.yml";
const ALL_PROFILES = ["redis84", "redis72", "prodlike", "toxiproxy", "replica"];
const DEFAULT_PROFILES = ["redis84", "redis72", "toxiproxy"];
const REDIS_SERVICES = ["redis84", "redis72", "prodlike", "replica"];
const TOXIPROXY_URL = `http://127.0.0.1:${process.env.NRC_TOXIPROXY_PORT ?? "8474"}`;

const [command = "help", ...rest] = process.argv.slice(2);

/** Runs `docker compose` with the given profiles; returns the exit status. */
function compose(profiles, args, { capture = false } = {}) {
  const profileArgs = profiles.flatMap((p) => ["--profile", p]);
  return run("docker", ["compose", "-f", COMPOSE_FILE, ...profileArgs, ...args], { capture, shell: false }).status;
}

function ensureDocker() {
  const { status, stderr } = run("docker", ["version", "--format", "{{.Server.Version}}"], { capture: true, shell: false });
  if (status !== 0) {
    console.error("[infra] Docker is not reachable. Start Docker Desktop (Windows) or the Docker daemon (Linux).");
    console.error(stderr.trim());
    process.exit(1);
  }
}

function parseProfiles(args) {
  if (args.length === 0) return DEFAULT_PROFILES;
  if (args.includes("all")) return ALL_PROFILES;
  const unknown = args.filter((p) => !ALL_PROFILES.includes(p));
  if (unknown.length > 0) {
    console.error(`[infra] unknown profile(s): ${unknown.join(", ")}. Known: ${ALL_PROFILES.join(", ")}, all`);
    process.exit(1);
  }
  return args;
}

/** Polls the toxiproxy HTTP API until it answers or the deadline passes. */
async function waitForToxiproxy(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${TOXIPROXY_URL}/version`);
      if (res.ok) return (await res.text()).trim();
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`[infra] toxiproxy API ${TOXIPROXY_URL} not ready within ${timeoutMs}ms (${lastError})`);
}

async function up(args) {
  ensureDocker();
  const profiles = parseProfiles(args);
  console.log(`[infra] starting profiles: ${profiles.join(", ")}`);
  const status = compose(profiles, ["up", "-d", "--wait", "--wait-timeout", "120", "--remove-orphans"]);
  if (status !== 0) {
    console.error("[infra] docker compose up failed");
    compose(profiles, ["ps", "-a"]);
    process.exit(status);
  }
  if (profiles.includes("toxiproxy")) {
    const version = await waitForToxiproxy();
    console.log(`[infra] toxiproxy ${version} ready at ${TOXIPROXY_URL}`);
  }
  compose(profiles, ["ps"]);
}

function down() {
  ensureDocker();
  process.exit(compose(ALL_PROFILES, ["down", "-v", "--remove-orphans"]));
}

function cli(args) {
  ensureDocker();
  const [service = "redis84", ...cliArgs] = args;
  if (!REDIS_SERVICES.includes(service)) {
    console.error(`[infra] cli supports: ${REDIS_SERVICES.join(", ")}`);
    process.exit(1);
  }
  const profileArgs = ALL_PROFILES.flatMap((p) => ["--profile", p]);
  const execArgs = ["compose", "-f", COMPOSE_FILE, ...profileArgs, "exec"];
  if (!process.stdin.isTTY) execArgs.push("-T");
  execArgs.push(service, "redis-cli", "-a", "test", "--no-auth-warning", ...cliArgs);
  const result = spawnSync("docker", execArgs, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

switch (command) {
  case "up":
    await up(rest);
    break;
  case "down":
    down();
    break;
  case "ps":
    ensureDocker();
    process.exit(compose(ALL_PROFILES, ["ps", "-a"]));
    break;
  case "logs":
    ensureDocker();
    process.exit(compose(ALL_PROFILES, ["logs", "--tail", "200", ...rest]));
    break;
  case "cli":
    cli(rest);
    break;
  default:
    console.log("usage: node scripts/infra.mjs <up [profiles...|all] | down | ps | logs [service] | cli [service] [args...]>");
    process.exit(command === "help" ? 0 : 1);
}
