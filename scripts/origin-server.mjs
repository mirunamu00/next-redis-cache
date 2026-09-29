// Origin server for the test apps (ROADMAP.md section 6.3): a versioned key-value store over HTTP that
// counts how often each datum is fetched. Pages fetch from it, so "origin hits" tell a test whether a
// response was regenerated (hit count grows) or served from the cache (hit count unchanged).
//
//   GET  /data/:key[?delay=ms]  -> { key, version, servedAt }   (counts a hit; optional delay)
//   POST /data/:key             -> { key, version }             (bumps the version)
//   POST /delay/:key?ms=N       -> sets a default delay for the key (0 clears it)
//   GET  /hits                  -> { [key]: count }
//   POST /reset                 -> clears versions, hits and delays
//   GET  /health                -> "ok"
//
// Module use: `const origin = await startOriginServer(); ... await origin.close();`
// CLI use:    node scripts/origin-server.mjs [--port 4010]
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {{ port?: number, host?: string }} [opts]
 */
export async function startOriginServer({ port = 0, host = "127.0.0.1" } = {}) {
  const versions = new Map();
  const hits = new Map();
  const delays = new Map();
  const sockets = new Set();

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://origin");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    try {
      if (req.method === "GET" && url.pathname === "/health") return res.end("ok");
      if (req.method === "GET" && url.pathname === "/hits") return json(res, 200, Object.fromEntries(hits));
      if (req.method === "POST" && url.pathname === "/reset") {
        versions.clear();
        hits.clear();
        delays.clear();
        return json(res, 200, { ok: true });
      }
      if (parts[0] === "data" && parts.length === 2) {
        const key = parts[1];
        if (req.method === "GET") {
          hits.set(key, (hits.get(key) ?? 0) + 1);
          const delay = Number(url.searchParams.get("delay") ?? delays.get(key) ?? 0);
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          return json(res, 200, { key, version: versions.get(key) ?? 1, servedAt: Date.now() });
        }
        if (req.method === "POST") {
          const version = (versions.get(key) ?? 1) + 1;
          versions.set(key, version);
          return json(res, 200, { key, version });
        }
      }
      if (req.method === "POST" && parts[0] === "delay" && parts.length === 2) {
        const ms = Number(url.searchParams.get("ms") ?? 0);
        if (ms > 0) delays.set(parts[1], ms);
        else delays.delete(parts[1]);
        return json(res, 200, { key: parts[1], delay: ms });
      }
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const url = `http://${host}:${actualPort}`;

  return {
    url,
    port: actualPort,
    hits: (key) => hits.get(key) ?? 0,
    allHits: () => Object.fromEntries(hits),
    version: (key) => versions.get(key) ?? 1,
    bump: (key) => {
      const v = (versions.get(key) ?? 1) + 1;
      versions.set(key, v);
      return v;
    },
    setDelay: (key, ms) => (ms > 0 ? delays.set(key, ms) : delays.delete(key)),
    reset: () => {
      versions.clear();
      hits.clear();
      delays.clear();
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf("--port");
  const port = i > 0 ? Number(process.argv[i + 1]) : 4010;
  const origin = await startOriginServer({ port });
  console.log(`[origin] listening on ${origin.url}`);
  const stop = async () => {
    await origin.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
