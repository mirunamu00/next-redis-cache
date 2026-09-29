/**
 * Tiny in-process Redis server (RESP2 over TCP) for fault tests that need no Docker.
 *
 * Ported from the docs app fixture (docs/tests/unit/fixtures/mini-redis.mjs). It is a real socket
 * server, not a mock, so a real `@redis/client` goes through the actual lifecycle:
 * disconnect -> isReady false -> background reconnect -> recovery.
 *
 * Controls:
 * - `stop()`     close the server and drop every connection (outage)
 * - `start()`    listen again on the same port (recovery); data is kept (use `flush()` to clear)
 * - `hang(on)`   stop answering commands (unresponsive Redis); turning it off drops connections
 *                so that client pipelines start clean
 * - `age(sec)`   move the last-access time of every key `sec` seconds into the past
 *                (OBJECT IDLETIME grows accordingly)
 *
 * Semantics:
 * - Only the commands used by the cache handlers and key cleanup are implemented.
 * - Expiry (SET EX/PX, EXPIRE) applies to strings, hashes and sorted sets.
 * - Last-access time is updated by reads, writes and EXPIRE, like real Redis; SCAN, EXISTS, TTL,
 *   PTTL and OBJECT do not touch it (LOOKUP_NOTOUCH).
 * - Values are binary-safe (stored as Buffer); keys, fields and members are UTF-8 strings.
 * - With `password` set, every command except AUTH fails with NOAUTH until authenticated.
 */
import net from "node:net";

type Reply =
  | null
  | number
  | string
  | Buffer
  | Reply[]
  | { simple: string }
  | { error: string };

export interface MiniRedisOptions {
  /** Fixed port; 0 (default) picks a free one. */
  port?: number;
  /** Require AUTH with this password (any username is accepted). */
  password?: string;
}

export interface MiniRedis {
  readonly url: string;
  readonly port: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  hang(on: boolean): void;
  flush(): void;
  age(seconds: number): void;
  /** Every command received, as [COMMAND, ...args] (args decoded as UTF-8). */
  readonly calls: string[][];
  /** Number of currently open client connections. */
  connectionCount(): number;
  getString(key: string): string | null;
  getBuffer(key: string): Buffer | null;
  /** Writes a string value (optional TTL in seconds) and sets last access to now. */
  setString(key: string, value: string | Buffer, exSeconds?: number): void;
  /** Writes hash fields (no TTL) and sets last access to now. */
  setHash(key: string, fields: Record<string, string | number>): void;
  /** Accesses one key like GET would (updates last access). */
  touch(key: string): void;
  /** Remaining TTL in seconds: -1 without TTL, -2 when the key does not exist. Does not touch. */
  ttl(key: string): number;
  /** Seconds since last access, or null when the key does not exist. Does not touch. */
  idle(key: string): number | null;
  hash(key: string): Map<string, string>;
  keys(): string[];
}

const CRLF = Buffer.from("\r\n");

export async function startMiniRedis({ port: fixedPort = 0, password }: MiniRedisOptions = {}): Promise<MiniRedis> {
  const strings = new Map<string, Buffer>();
  const hashes = new Map<string, Map<string, string>>();
  const zsets = new Map<string, Map<string, number>>();
  const expires = new Map<string, number>(); // key -> expiry time (ms)
  const touched = new Map<string, number>(); // key -> last access time (ms)
  const sockets = new Set<net.Socket>();
  const calls: string[][] = [];
  let hanging = false;
  let server: net.Server | undefined;
  let port = fixedPort;

  const drop = (key: string): boolean => {
    const had = [strings.delete(key), hashes.delete(key), zsets.delete(key)].some(Boolean);
    expires.delete(key);
    touched.delete(key);
    return had;
  };
  /** Existence check that applies lazy expiry. */
  const exists = (key: string): boolean => {
    const e = expires.get(key);
    if (e !== undefined && e <= Date.now()) drop(key);
    return strings.has(key) || hashes.has(key) || zsets.has(key);
  };
  const touch = (key: string): void => {
    if (exists(key)) touched.set(key, Date.now());
  };
  const alive = (key: string): Buffer | undefined => (exists(key) ? strings.get(key) : undefined);
  const pttlOf = (key: string): number => {
    if (!exists(key)) return -2;
    const e = expires.get(key);
    return e === undefined ? -1 : Math.max(0, e - Date.now());
  };
  const ttlOf = (key: string): number => {
    const ms = pttlOf(key);
    return ms < 0 ? ms : Math.ceil(ms / 1000);
  };
  const idleOf = (key: string): number | null =>
    exists(key) ? Math.floor((Date.now() - (touched.get(key) ?? Date.now())) / 1000) : null;
  const allKeys = (): string[] =>
    [...new Set([...strings.keys(), ...hashes.keys(), ...zsets.keys()])].filter(exists);
  const glob = (pattern: string): RegExp =>
    new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$",
    );
  const wrongArgs = (cmd: string): Reply => ({ error: `ERR wrong number of arguments for '${cmd.toLowerCase()}' command` });

  function exec(argv: Buffer[], session: { authed: boolean }): Reply {
    const args = argv.map((b) => b.toString("utf8"));
    const [cmdRaw = "", ...a] = args;
    const cmd = cmdRaw.toUpperCase();
    calls.push([cmd, ...a]);

    if (cmd === "AUTH") {
      if (password === undefined) return { error: "ERR AUTH <password> called without any password configured for the default user." };
      const given = a[a.length - 1];
      if (given !== password) return { error: "WRONGPASS invalid username-password pair or user is disabled." };
      session.authed = true;
      return { simple: "OK" };
    }
    if (password !== undefined && !session.authed) return { error: "NOAUTH Authentication required." };

    switch (cmd) {
      case "PING":
        return { simple: "PONG" };
      case "CLIENT":
      case "SELECT":
        return { simple: "OK" };
      case "DBSIZE":
        return allKeys().length;
      case "GET":
        if (a.length !== 1) return wrongArgs(cmd);
        touch(a[0]!);
        return alive(a[0]!) ?? null;
      case "SET": {
        if (a.length < 2) return wrongArgs(cmd);
        const key = a[0]!;
        const value = argv[2]!;
        let nx = false;
        let ttlMs = 0;
        for (let i = 2; i < a.length; i++) {
          const o = a[i]!.toUpperCase();
          if (o === "NX") nx = true;
          else if (o === "EX") ttlMs = Number(a[++i]) * 1000;
          else if (o === "PX") ttlMs = Number(a[++i]);
          else return { error: `ERR mini-redis: unsupported SET option '${a[i]}'` };
        }
        if (nx && exists(key)) return null;
        drop(key); // SET clears any previous TTL (KEEPTTL is not supported)
        strings.set(key, Buffer.from(value));
        if (ttlMs) expires.set(key, Date.now() + ttlMs);
        touch(key);
        return { simple: "OK" };
      }
      case "DEL":
      case "UNLINK": {
        let n = 0;
        for (const k of a) if (exists(k) && drop(k)) n++;
        return n;
      }
      case "EXISTS":
        return a.filter(exists).length;
      case "TTL":
        return ttlOf(a[0]!);
      case "PTTL":
        return pttlOf(a[0]!);
      case "EXPIRE": {
        const key = a[0]!;
        if (!exists(key)) return 0;
        touch(key); // real Redis uses lookupKeyWrite for EXPIRE, which updates the access time
        expires.set(key, Date.now() + Number(a[1]) * 1000);
        return 1;
      }
      case "OBJECT":
        if (a[0]?.toUpperCase() !== "IDLETIME") return { error: "ERR mini-redis: only OBJECT IDLETIME is supported" };
        return idleOf(a[1]!);
      case "HSET": {
        const key = a[0]!;
        exists(key);
        const h = hashes.get(key) ?? new Map<string, string>();
        hashes.set(key, h);
        let n = 0;
        for (let i = 1; i < a.length; i += 2) {
          if (!h.has(a[i]!)) n++;
          h.set(a[i]!, a[i + 1]!);
        }
        touch(key);
        return n;
      }
      case "HEXISTS":
        touch(a[0]!);
        return exists(a[0]!) && hashes.get(a[0]!)?.has(a[1]!) ? 1 : 0;
      case "HDEL": {
        const key = a[0]!;
        touch(key);
        const h = exists(key) ? hashes.get(key) : undefined;
        let n = 0;
        for (const f of a.slice(1)) if (h?.delete(f)) n++;
        if (h && h.size === 0) drop(key);
        return n;
      }
      case "HMGET": {
        touch(a[0]!);
        const h = exists(a[0]!) ? hashes.get(a[0]!) : undefined;
        return a.slice(1).map((f) => h?.get(f) ?? null);
      }
      case "HGETALL": {
        touch(a[0]!);
        const h = (exists(a[0]!) && hashes.get(a[0]!)) || new Map<string, string>();
        return [...h].flat();
      }
      case "HSCAN": {
        // Single-pass scan: everything in one page, cursor "0"
        touch(a[0]!);
        const h = (exists(a[0]!) && hashes.get(a[0]!)) || new Map<string, string>();
        return ["0", [...h].flat()];
      }
      case "ZADD": {
        const key = a[0]!;
        exists(key);
        const z = zsets.get(key) ?? new Map<string, number>();
        zsets.set(key, z);
        let n = 0;
        for (let i = 1; i < a.length; i += 2) {
          if (!z.has(a[i + 1]!)) n++;
          z.set(a[i + 1]!, Number(a[i]));
        }
        touch(key);
        return n;
      }
      case "ZRANGE": {
        touch(a[0]!);
        const z = (exists(a[0]!) && zsets.get(a[0]!)) || new Map<string, number>();
        const sorted = [...z].sort((x, y) => x[1] - y[1]).map(([m]) => m);
        const start = Number(a[1]);
        const stop = Number(a[2]);
        return sorted.slice(start, stop < 0 ? sorted.length + stop + 1 : stop + 1);
      }
      case "ZREM": {
        touch(a[0]!);
        const z = exists(a[0]!) ? zsets.get(a[0]!) : undefined;
        let n = 0;
        for (const m of a.slice(1)) if (z?.delete(m)) n++;
        return n;
      }
      case "SCAN": {
        // Single-pass scan: MATCH is honored, COUNT is ignored, cursor is always "0"
        let match = "*";
        for (let i = 1; i < a.length; i++) if (a[i]!.toUpperCase() === "MATCH") match = a[++i]!;
        const re = glob(match);
        return ["0", allKeys().filter((k) => re.test(k))];
      }
      case "FLUSHALL":
      case "FLUSHDB":
        clearAll();
        return { simple: "OK" };
      default:
        return { error: `ERR unknown command '${cmdRaw}'` };
    }
  }

  function clearAll(): void {
    strings.clear();
    hashes.clear();
    zsets.clear();
    expires.clear();
    touched.clear();
  }

  function encode(v: Reply, out: Buffer[]): void {
    if (v === null || v === undefined) out.push(Buffer.from("$-1\r\n"));
    else if (typeof v === "number") out.push(Buffer.from(`:${v}\r\n`));
    else if (Array.isArray(v)) {
      out.push(Buffer.from(`*${v.length}\r\n`));
      for (const item of v) encode(item, out);
    } else if (Buffer.isBuffer(v)) out.push(Buffer.from(`$${v.length}\r\n`), v, CRLF);
    else if (typeof v === "object" && "simple" in v) out.push(Buffer.from(`+${v.simple}\r\n`));
    else if (typeof v === "object" && "error" in v) out.push(Buffer.from(`-${v.error}\r\n`));
    else {
      const b = Buffer.from(String(v));
      out.push(Buffer.from(`$${b.length}\r\n`), b, CRLF);
    }
  }

  /** Extracts one RESP array command from the buffer, or returns null when more data is needed. */
  function parse(buf: Buffer, offset: number): { argv: Buffer[]; next: number } | null {
    if (buf[offset] !== 0x2a) throw new Error("mini-redis: inline commands are not supported");
    let nl = buf.indexOf(CRLF, offset);
    if (nl < 0) return null;
    const count = Number(buf.toString("latin1", offset + 1, nl));
    let pos = nl + 2;
    const argv: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      nl = buf.indexOf(CRLF, pos);
      if (nl < 0) return null;
      const len = Number(buf.toString("latin1", pos + 1, nl));
      pos = nl + 2;
      if (buf.length < pos + len + 2) return null;
      argv.push(Buffer.from(buf.subarray(pos, pos + len)));
      pos += len + 2;
    }
    return { argv, next: pos };
  }

  function onConnection(socket: net.Socket): void {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const session = { authed: false };
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      let offset = 0;
      const out: Buffer[] = [];
      for (;;) {
        if (offset >= pending.length) break;
        let parsed;
        try {
          parsed = parse(pending, offset);
        } catch (err) {
          socket.destroy(err as Error);
          return;
        }
        if (!parsed) break;
        offset = parsed.next;
        if (hanging) continue; // no reply
        encode(exec(parsed.argv, session), out);
      }
      pending = pending.subarray(offset);
      if (out.length > 0) socket.write(Buffer.concat(out));
    });
  }

  async function start(): Promise<void> {
    const srv = net.createServer(onConnection);
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => resolve());
    });
    server = srv;
    port = (srv.address() as net.AddressInfo).port;
  }

  async function stop(): Promise<void> {
    for (const s of sockets) s.destroy();
    const srv = server;
    server = undefined;
    if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  await start();

  return {
    get url() {
      return `redis://127.0.0.1:${port}`;
    },
    get port() {
      return port;
    },
    start,
    stop,
    hang(on: boolean) {
      hanging = on;
      if (!on) for (const s of sockets) s.destroy();
    },
    flush: clearAll,
    age(seconds: number) {
      for (const [k, t] of touched) touched.set(k, t - seconds * 1000);
    },
    calls,
    connectionCount: () => sockets.size,
    getString: (k) => alive(k)?.toString("utf8") ?? null,
    getBuffer: (k) => {
      const v = alive(k);
      return v ? Buffer.from(v) : null;
    },
    setString: (k, v, exSeconds = 0) => {
      drop(k);
      strings.set(k, Buffer.from(v));
      if (exSeconds) expires.set(k, Date.now() + exSeconds * 1000);
      touched.set(k, Date.now());
    },
    setHash: (k, obj) => {
      exists(k);
      const h = hashes.get(k) ?? new Map<string, string>();
      hashes.set(k, h);
      for (const [f, v] of Object.entries(obj)) h.set(f, String(v));
      touched.set(k, Date.now());
    },
    touch,
    ttl: ttlOf,
    idle: idleOf,
    hash: (k) => new Map((exists(k) && hashes.get(k)) || []),
    keys: () => allKeys(),
  };
}
