/**
 * Minimal Toxiproxy HTTP API client (https://github.com/Shopify/toxiproxy#http-api).
 *
 * The toxiproxy container comes from docker/compose.yml (`npm run infra:up`). Tests talk to its
 * control API directly over HTTP (default http://127.0.0.1:8474, override with NRC_TOXIPROXY_URL or
 * NRC_TOXIPROXY_PORT).
 *
 * Isolation: each vitest worker owns one dynamic proxy, `nrc_w<poolId>`, listening on
 * 26399 + poolId (26400-26415 are mapped to the host by compose). Test files within a worker run
 * sequentially, so a worker proxy is never shared concurrently.
 */
import { poolId } from "./namespace";
import { redisUrl } from "./redis";

export type ToxicType = "latency" | "timeout" | "reset_peer" | "bandwidth" | "limit_data" | "slow_close" | "slicer";
export type ToxicStream = "upstream" | "downstream";

export interface Toxic {
  name: string;
  type: ToxicType;
  stream: ToxicStream;
  toxicity: number;
  attributes: Record<string, number>;
}

export interface Proxy {
  name: string;
  listen: string;
  upstream: string;
  enabled: boolean;
  toxics: Toxic[];
}

export interface ToxicInput {
  type: ToxicType;
  attributes: Record<string, number>;
  /** Defaults to "<type>_<stream>". */
  name?: string;
  /** Defaults to "downstream" (server -> client). */
  stream?: ToxicStream;
  /** Probability 0-1 that the toxic applies to a connection (default 1). */
  toxicity?: number;
}

/** First host port of the per-worker proxy range; must match docker/compose.yml. */
export const WORKER_PROXY_BASE_PORT = 26400;
export const WORKER_PROXY_COUNT = 16;

export function toxiproxyApiUrl(): string {
  return process.env.NRC_TOXIPROXY_URL ?? `http://127.0.0.1:${process.env.NRC_TOXIPROXY_PORT ?? "8474"}`;
}

export class ToxiproxyClient {
  constructor(readonly apiUrl: string = toxiproxyApiUrl()) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`toxiproxy API ${this.apiUrl} is unreachable (run \`npm run infra:up\`): ${String(err)}`, {
        cause: err,
      });
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`toxiproxy ${method} ${path} failed: HTTP ${res.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async version(): Promise<string> {
    const res = await fetch(`${this.apiUrl}/version`).catch((err: unknown) => {
      throw new Error(`toxiproxy API ${this.apiUrl} is unreachable (run \`npm run infra:up\`): ${String(err)}`, {
        cause: err,
      });
    });
    const text = (await res.text()).trim();
    // 2.x answers {"version": "..."}; older releases answered with the plain version string
    try {
      return (JSON.parse(text) as { version: string }).version;
    } catch {
      return text;
    }
  }

  proxies(): Promise<Record<string, Proxy>> {
    return this.request("GET", "/proxies");
  }

  createProxy(p: { name: string; listen: string; upstream: string; enabled?: boolean }): Promise<Proxy> {
    return this.request("POST", "/proxies", { enabled: true, ...p });
  }

  deleteProxy(name: string): Promise<void> {
    return this.request("DELETE", `/proxies/${encodeURIComponent(name)}`);
  }

  setEnabled(name: string, enabled: boolean): Promise<Proxy> {
    return this.request("POST", `/proxies/${encodeURIComponent(name)}`, { enabled });
  }

  toxics(proxy: string): Promise<Toxic[]> {
    return this.request("GET", `/proxies/${encodeURIComponent(proxy)}/toxics`);
  }

  addToxic(proxy: string, t: ToxicInput): Promise<Toxic> {
    const stream = t.stream ?? "downstream";
    return this.request("POST", `/proxies/${encodeURIComponent(proxy)}/toxics`, {
      name: t.name ?? `${t.type}_${stream}`,
      type: t.type,
      stream,
      toxicity: t.toxicity ?? 1,
      attributes: t.attributes,
    });
  }

  removeToxic(proxy: string, toxic: string): Promise<void> {
    return this.request("DELETE", `/proxies/${encodeURIComponent(proxy)}/toxics/${encodeURIComponent(toxic)}`);
  }

  /** Enables every proxy and removes every toxic (global; avoid in parallel tests). */
  reset(): Promise<void> {
    return this.request("POST", "/reset");
  }

  /**
   * (Re)creates this worker's private proxy in front of `upstream` (a host:port reachable from the
   * toxiproxy container, e.g. "redis84:6379") and returns a handle for it.
   */
  async workerProxy(upstream = "redis84:6379"): Promise<ProxyHandle> {
    const id = poolId();
    if (id > WORKER_PROXY_COUNT) {
      throw new Error(`vitest pool id ${id} exceeds the ${WORKER_PROXY_COUNT} mapped toxiproxy ports; lower maxWorkers`);
    }
    const hostPort = WORKER_PROXY_BASE_PORT + id - 1;
    const listen = `0.0.0.0:${hostPort}`;
    const name = `nrc_w${id}`;
    // Remove leftovers from an interrupted run: same name, or anything else bound to our port
    for (const p of Object.values(await this.proxies())) {
      if (p.name === name || p.listen.endsWith(`:${hostPort}`)) await this.deleteProxy(p.name);
    }
    await this.createProxy({ name, listen, upstream });
    return new ProxyHandle(this, name, "127.0.0.1", hostPort);
  }
}

/** A proxy as seen from the test process, with helpers for the common toxics. */
export class ProxyHandle {
  constructor(
    readonly api: ToxiproxyClient,
    readonly name: string,
    readonly host: string,
    readonly port: number,
  ) {}

  /** redis:// URL through the proxy, with the test password. */
  get url(): string {
    return redisUrl(this.host, this.port);
  }

  add(t: ToxicInput): Promise<Toxic> {
    return this.api.addToxic(this.name, t);
  }

  remove(toxicName: string): Promise<void> {
    return this.api.removeToxic(this.name, toxicName);
  }

  /** Adds `latency` ms (plus/minus `jitter`) to every chunk. */
  latency(latency: number, jitter = 0, stream: ToxicStream = "downstream"): Promise<Toxic> {
    return this.add({ type: "latency", stream, attributes: { latency, jitter } });
  }

  /** Stops all data; closes the connection after `timeout` ms (0 = never close, keep dropping). */
  timeout(timeout: number, stream: ToxicStream = "upstream"): Promise<Toxic> {
    return this.add({ type: "timeout", stream, attributes: { timeout } });
  }

  /** Resets connections with TCP RST (ECONNRESET), after `timeout` ms of data (0 = immediately). */
  resetPeer(timeout = 0, stream: ToxicStream = "upstream"): Promise<Toxic> {
    return this.add({ type: "reset_peer", stream, attributes: { timeout } });
  }

  /** Limits throughput to `rate` KB/s. */
  bandwidth(rate: number, stream: ToxicStream = "downstream"): Promise<Toxic> {
    return this.add({ type: "bandwidth", stream, attributes: { rate } });
  }

  /** Closes the connection after `bytes` bytes have passed. */
  limitData(bytes: number, stream: ToxicStream = "downstream"): Promise<Toxic> {
    return this.add({ type: "limit_data", stream, attributes: { bytes } });
  }

  /** Removes every toxic on this proxy and makes sure it is enabled. */
  async clear(): Promise<void> {
    for (const t of await this.api.toxics(this.name)) await this.api.removeToxic(this.name, t.name);
    await this.api.setEnabled(this.name, true);
  }

  /** Disables the proxy: open connections are closed and new ones are refused. */
  disable(): Promise<Proxy> {
    return this.api.setEnabled(this.name, false);
  }

  enable(): Promise<Proxy> {
    return this.api.setEnabled(this.name, true);
  }

  destroy(): Promise<void> {
    return this.api.deleteProxy(this.name);
  }
}
