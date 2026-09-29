// Multi-instance runner for standalone test-app builds (ROADMAP.md section 6.4 "multi-instance, rolling").
//
// A fleet is N `node server.js` processes (each on its own port, with INSTANCE_ID set) behind a built-in
// round-robin load balancer. Instances of different builds (BUILD_ID A/B) can share one Redis, which
// lets tests replay a Kubernetes rolling update (maxSurge 1, maxUnavailable 0) and a rollback.
//
// Module use (e2e / chaos / perf):
//   const fleet = await startFleet({ app: "static-site", builds: ["A"], instances: 2, redisUrl, namespace });
//   fetch(fleet.url + "/about"); fleet.instances[0].url; await fleet.rolling("B"); await fleet.stop();
//
// CLI use (manual debugging):
//   node scripts/fleet.mjs --app static-site [--variant next-16.3] [--build A] [--instances 2]
//                          [--port 3000] [--redis redis://default:test@127.0.0.1:6384] [--ns nrc]
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startOriginServer } from "./origin-server.mjs";
import { DEFAULT_VARIANT, REPO_ROOT, WORK_DIR, buildDir, exists, readJson } from "./lib/work.mjs";

export const DEFAULT_REDIS_URL = `redis://default:test@127.0.0.1:${process.env.NRC_REDIS84_PORT ?? "6384"}`;
const READY_PATH = "/api/nrc-test/stats";

/** A free localhost port (bound, then released). */
export async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Deletes every key of a fleet namespace (SCAN + UNLINK). Returns the number of deleted keys. */
export async function dropNamespace(redisUrl, namespace) {
  if (!redisUrl) return 0;
  const { createClient } = await import("@redis/client");
  const client = createClient({ url: redisUrl, socket: { reconnectStrategy: false, connectTimeout: 2000 } });
  client.on("error", () => {});
  try {
    await client.connect();
  } catch {
    return 0; // Redis is down (chaos tests): nothing to clean
  }
  let deleted = 0;
  try {
    for await (const keys of client.scanIterator({ MATCH: `${namespace}:*`, COUNT: 500 })) {
      if (keys.length > 0) deleted += await client.unlink(keys);
    }
  } finally {
    client.destroy();
  }
  return deleted;
}

/**
 * Starts one standalone server and waits until it answers.
 * @param {{ dir: string, id: string, env: Record<string,string>, logDir: string, readyTimeoutMs?: number }} o
 */
export async function startInstance({ dir, id, env, logDir, readyTimeoutMs = 120_000 }) {
  if (!exists(path.join(dir, "server.js"))) throw new Error(`no standalone build at ${dir} (run scripts/prepare-app.mjs --build)`);
  const meta = readJson(path.join(dir, "nrc-build.json"), {});
  const port = await freePort();
  mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${id}.log`);
  const logStream = createWriteStream(logFile);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      TEST_HOOKS: "1",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      INSTANCE_ID: id,
      BUILD_ID: meta.buildId ?? "default",
      NRC_API: meta.api ?? "v1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const tail = [];
  const onData = (chunk) => {
    logStream.write(chunk);
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (!line) continue;
      tail.push(line);
      if (tail.length > 200) tail.shift();
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const instance = {
    id,
    build: meta.buildId,
    port,
    url: `http://127.0.0.1:${port}`,
    process: child,
    logFile,
    exitCode: undefined,
    exitSignal: undefined,
    /** true once stop() was requested: an exit afterwards is expected, not a crash */
    stopping: false,
    logs: () => tail.join("\n"),
    get alive() {
      return instance.exitCode === undefined && instance.exitSignal === undefined;
    },
    /** Crashed = exited without being asked to. */
    get crashed() {
      return !instance.alive && !instance.stopping;
    },
    async stop(timeoutMs = 5000) {
      instance.stopping = true;
      if (!instance.alive) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const done = await Promise.race([exited.then(() => true), sleep(timeoutMs).then(() => false)]);
      if (!done) {
        child.kill("SIGKILL");
        await exited;
      }
      logStream.end();
    },
  };
  child.on("exit", (code, signal) => {
    instance.exitCode = code ?? undefined;
    instance.exitSignal = signal ?? undefined;
    if (code === null && signal === null) instance.exitCode = -1;
  });

  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (!instance.alive) throw new Error(`instance ${id} exited during startup (code ${instance.exitCode})\n${instance.logs()}`);
    try {
      const res = await fetch(instance.url + READY_PATH, { signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await instance.stop();
      throw new Error(`instance ${id} not ready within ${readyTimeoutMs}ms\n${instance.logs()}`);
    }
    await sleep(100);
  }
  return instance;
}

/** Round-robin HTTP load balancer over the fleet's routable instances. */
async function startBalancer(pool, port) {
  let next = 0;
  const server = http.createServer((req, res) => {
    const targets = pool();
    if (targets.length === 0) {
      res.writeHead(503, { "x-nrc-lb": "no-upstream" });
      res.end("no upstream");
      return;
    }
    const target = targets[next++ % targets.length];
    const upstream = http.request(
      { host: "127.0.0.1", port: target.port, method: req.method, path: req.url, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, { ...up.headers, "x-nrc-upstream": target.id });
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "x-nrc-upstream": target.id, "x-nrc-lb": "upstream-error" });
      res.end(String(err));
    });
    req.pipe(upstream);
  });
  const sockets = new Set();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

let fleetSeq = 0;

/**
 * @param {{
 *   app: string, variant?: string, builds?: string[], instances?: number, redisUrl?: string,
 *   namespace?: string, originUrl?: string, env?: Record<string,string>, lbPort?: number,
 *   readyTimeoutMs?: number, keepKeys?: boolean
 * }} o
 * `builds` lists the build id of each initial instance, cycling if shorter than `instances`.
 */
export async function startFleet({
  app,
  variant = DEFAULT_VARIANT,
  builds = ["A"],
  instances = 2,
  redisUrl = DEFAULT_REDIS_URL,
  namespace = `fleet_${process.pid}_${++fleetSeq}`,
  originUrl,
  env = {},
  lbPort = 0,
  readyTimeoutMs,
  keepKeys = process.env.NRC_KEEP_KEYS === "1",
}) {
  let origin;
  if (!originUrl) {
    origin = await startOriginServer();
    originUrl = origin.url;
  }
  const logDir = path.join(WORK_DIR, "logs", `${app}@${variant}`, namespace);
  const members = [];
  let seq = 0;
  const baseEnv = { REDIS_URL: redisUrl, TEST_NS: namespace, ORIGIN_URL: originUrl, ...env };

  const launch = async (build, extraEnv = {}) => {
    const id = `i${++seq}-${build}`;
    const inst = await startInstance({
      dir: buildDir(app, variant, build),
      id,
      env: { ...baseEnv, ...extraEnv },
      logDir,
      readyTimeoutMs,
    });
    inst.routable = true;
    members.push(inst);
    return inst;
  };

  const balancer = await startBalancer(() => members.filter((m) => m.routable && m.alive), lbPort);
  try {
    await Promise.all(Array.from({ length: instances }, (_, i) => launch(builds[i % builds.length])));
  } catch (err) {
    await Promise.all(members.map((m) => m.stop()));
    await balancer.close();
    await origin?.close();
    throw err;
  }

  const fleet = {
    app,
    variant,
    namespace,
    url: `http://127.0.0.1:${balancer.port}`,
    origin,
    originUrl,
    logDir,
    /** Every instance ever started (including stopped ones). */
    get all() {
      return [...members];
    },
    /** Instances currently receiving traffic. */
    get instances() {
      return members.filter((m) => m.routable && m.alive);
    },
    /** Instances that exited without being stopped (I2: must stay empty). */
    get crashed() {
      return members.filter((m) => m.crashed);
    },
    start: launch,
    async stopInstance(inst) {
      inst.routable = false;
      await inst.stop();
    },
    /**
     * Rolling update to `build` (maxSurge 1, maxUnavailable 0): for each current instance, start one
     * new instance, wait until it is ready, route to it, then drain and stop one old instance.
     * `onStep` runs after each replacement (tests use it to send traffic mid-rollout).
     */
    async rolling(build, { onStep, extraEnv } = {}) {
      const old = fleet.instances.filter((m) => m.build !== build);
      for (const o of old) {
        await launch(build, extraEnv);
        o.routable = false;
        await o.stop();
        if (onStep) await onStep(fleet);
      }
    },
    /** GET (or other method) through the load balancer. */
    request(p, init) {
      return fetch(fleet.url + p, init);
    },
    async stats() {
      return Promise.all(
        fleet.instances.map(async (m) => ({ id: m.id, ...(await (await fetch(m.url + READY_PATH)).json()) })),
      );
    },
    /** Stops every instance, the balancer and the origin; deletes the namespace unless keepKeys. */
    async stop() {
      await Promise.all(members.map((m) => m.stop()));
      await balancer.close();
      await origin?.close();
      if (!keepKeys) await dropNamespace(redisUrl, namespace);
    },
  };
  return fleet;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { values } = parseArgs({
    options: {
      app: { type: "string" },
      variant: { type: "string", default: DEFAULT_VARIANT },
      build: { type: "string", default: "A" },
      instances: { type: "string", default: "2" },
      port: { type: "string", default: "3000" },
      redis: { type: "string", default: DEFAULT_REDIS_URL },
      ns: { type: "string", default: "nrc" },
      "origin-port": { type: "string", default: "4010" },
    },
  });
  if (!values.app) {
    console.error("usage: node scripts/fleet.mjs --app <static-site|full-legacy|full-cc> [--variant] [--build A[,B]] [--instances 2] [--port 3000] [--redis url] [--ns nrc]");
    process.exit(1);
  }
  const origin = await startOriginServer({ port: Number(values["origin-port"]) });
  const fleet = await startFleet({
    app: values.app,
    variant: values.variant,
    builds: values.build.split(","),
    instances: Number(values.instances),
    redisUrl: values.redis,
    namespace: values.ns,
    originUrl: origin.url,
    lbPort: Number(values.port),
  });
  console.log(`[fleet] ${values.app}@${values.variant} load balancer ${fleet.url} (origin ${origin.url})`);
  for (const m of fleet.instances) console.log(`[fleet]   ${m.id} build ${m.build} ${m.url} log ${path.relative(REPO_ROOT, m.logFile)}`);
  const stop = async () => {
    await fleet.stop();
    await origin.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
