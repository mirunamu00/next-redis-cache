/**
 * In-memory stand-in for a @redis/client client, for unit tests (no sockets, no timers of its own).
 *
 * Implements the commands the handlers and the maintenance code send, records every call, and lets a
 * test flip readiness, make commands hang or fail. Expiry uses Date.now(), so fake timers apply.
 */
export interface FakeCall {
  cmd: string;
  args: unknown[];
}

type Value = { kind: "string"; data: Buffer } | { kind: "hash"; data: Map<string, string> } | { kind: "zset"; data: Map<string, number> };

export interface FakeRedisOptions {
  ready?: boolean;
}

export class FakeRedis {
  isReady: boolean;
  isOpen = true;
  readonly calls: FakeCall[] = [];
  readonly store = new Map<string, Value>();
  readonly expires = new Map<string, number>();
  readonly lastAccess = new Map<string, number>();
  /** Commands never settle while set. */
  hanging = false;
  /** Every command rejects with this error while set. */
  failure: Error | undefined;
  /** Per-command failure injection. */
  failOn = new Map<string, Error>();
  #listeners = new Map<string, Array<(...a: unknown[]) => void>>();

  constructor({ ready = true }: FakeRedisOptions = {}) {
    this.isReady = ready;
  }

  on(event: string, fn: (...a: unknown[]) => void) {
    const list = this.#listeners.get(event) ?? [];
    list.push(fn);
    this.#listeners.set(event, list);
    return this;
  }

  off(event: string, fn: (...a: unknown[]) => void) {
    this.#listeners.set(event, (this.#listeners.get(event) ?? []).filter((f) => f !== fn));
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const fn of this.#listeners.get(event) ?? []) fn(...args);
  }

  /** Becomes ready and emits "ready" (like a reconnect). */
  becomeReady() {
    this.isReady = true;
    this.emit("ready");
  }

  withTypeMapping() {
    return this;
  }

  destroy() {
    this.isOpen = false;
    this.isReady = false;
  }

  count(cmd: string) {
    return this.calls.filter((c) => c.cmd === cmd).length;
  }

  #alive(key: string): Value | undefined {
    const e = this.expires.get(key);
    if (e !== undefined && e <= Date.now()) {
      this.store.delete(key);
      this.expires.delete(key);
    }
    return this.store.get(key);
  }

  #op<T>(cmd: string, args: unknown[], fn: () => T): Promise<T> {
    this.calls.push({ cmd, args });
    if (this.hanging) return new Promise<T>(() => {});
    const err = this.failure ?? this.failOn.get(cmd);
    if (err) return Promise.reject(err);
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e);
    }
  }

  #touch(key: string) {
    this.lastAccess.set(key, Date.now());
  }

  get(key: string) {
    return this.#op("get", [key], () => {
      const v = this.#alive(key);
      this.#touch(key);
      if (!v) return null;
      if (v.kind !== "string") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
      return v.data;
    });
  }

  set(key: string, value: string | Buffer, options?: { expiration?: { type: string; value: number }; condition?: string }) {
    return this.#op("set", [key, value, options], () => {
      if (options?.condition === "NX" && this.#alive(key)) return null;
      this.store.set(key, { kind: "string", data: Buffer.isBuffer(value) ? value : Buffer.from(String(value)) });
      this.expires.delete(key);
      const ex = options?.expiration;
      if (ex && ex.type === "EX") this.expires.set(key, Date.now() + ex.value * 1000);
      this.#touch(key);
      return "OK";
    });
  }

  #hash(key: string, create = false): Map<string, string> | undefined {
    const v = this.#alive(key);
    if (v && v.kind !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    if (v) return v.data;
    if (!create) return undefined;
    const data = new Map<string, string>();
    this.store.set(key, { kind: "hash", data });
    return data;
  }

  hSet(key: string, fields: Record<string, string | number>) {
    return this.#op("hSet", [key, fields], () => {
      const h = this.#hash(key, true)!;
      let n = 0;
      for (const [f, v] of Object.entries(fields)) {
        if (!h.has(f)) n++;
        h.set(f, String(v));
      }
      this.#touch(key);
      return n;
    });
  }

  hmGet(key: string, fields: string[]) {
    return this.#op("hmGet", [key, fields], () => {
      const h = this.#hash(key);
      this.#touch(key);
      return fields.map((f) => h?.get(f) ?? null);
    });
  }

  /** Per-field TTLs set by HEXPIRE (field -> expiry time in ms); not enforced, only recorded. */
  readonly fieldExpires = new Map<string, number>();

  hExpire(key: string, fields: string[], seconds: number) {
    return this.#op("hExpire", [key, fields, seconds], () => {
      const h = this.#hash(key);
      return fields.map((f) => {
        if (!h?.has(f)) return -2;
        this.fieldExpires.set(`${key}|${f}`, Date.now() + seconds * 1000);
        return 1;
      });
    });
  }

  hGetAll(key: string) {
    return this.#op("hGetAll", [key], () => Object.fromEntries(this.#hash(key) ?? []));
  }

  unlink(keys: string | string[]) {
    const list = Array.isArray(keys) ? keys : [keys];
    return this.#op("unlink", [list], () => {
      let n = 0;
      for (const k of list) if (this.#alive(k) && this.store.delete(k)) n++;
      return n;
    });
  }

  exists(key: string) {
    return this.#op("exists", [key], () => (this.#alive(key) ? 1 : 0));
  }

  pTTL(key: string) {
    return this.#op("pTTL", [key], () => {
      if (!this.#alive(key)) return -2;
      const e = this.expires.get(key);
      return e === undefined ? -1 : e - Date.now();
    });
  }
}

/** A FakeRedis typed as the handlers' client type. */
export function fakeRedis(options?: FakeRedisOptions) {
  const fake = new FakeRedis(options);
  return { fake, client: fake as never };
}
