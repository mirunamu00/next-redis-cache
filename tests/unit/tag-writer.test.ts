// Invalidation writes and the optional tag state TTL (ROADMAP.md D44): one HSET per call, HEXPIRE on the
// written fields when tagStateTtlSeconds is set, one warning and no TTL on a Redis without HEXPIRE.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../src/config";
import { Runner } from "../../src/runner";
import { TagStateWriter } from "../../src/tag-writer";
import type { RedisCacheConfig } from "../../src/types";
import { fakeRedis } from "../support/fake-redis";

const T0 = 1_800_000_000_000;

afterEach(() => {
  vi.useRealTimers();
});

function writer(extra: Partial<RedisCacheConfig> = {}) {
  const { fake, client } = fakeRedis();
  const warnings: string[] = [];
  const cfg = resolveConfig({ client, namespace: "ns", disabled: false, logger: { warn: (m) => warnings.push(String(m)) }, ...extra });
  return { fake, warnings, writer: new TagStateWriter(new Runner(cfg), cfg) };
}

describe("TagStateWriter", () => {
  it("writes one HSET into {namespace}:_tagstate and no TTL by default", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fake, writer: w } = writer();
    await w.write(["a", "b"], undefined);
    expect(fake.calls).toEqual([{ cmd: "hSet", args: ["ns:_tagstate", { "x:a": String(T0), "x:b": String(T0) }] }]);
    expect(await fake.pTTL("ns:_tagstate")).toBe(-1);
  });

  it("with tagStateTtlSeconds puts HEXPIRE on exactly the written fields, counted from the latest recorded time", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fake, writer: w } = writer({ tagStateTtlSeconds: 3600 });
    await w.write(["t"], { expire: 600 });
    const hexpire = fake.calls.find((c) => c.cmd === "hExpire");
    expect(hexpire?.args).toEqual(["ns:_tagstate", ["s:t", "x:t"], 3600 + 600]);
    await w.write(["u"], undefined);
    expect(fake.calls.filter((c) => c.cmd === "hExpire").at(-1)?.args).toEqual(["ns:_tagstate", ["x:u"], 3600]);
    expect(fake.fieldExpires.get("ns:_tagstate|x:u")).toBe(T0 + 3600 * 1000);
  });

  it("on a Redis without HEXPIRE: one warning, then no more HEXPIRE; the invalidation itself succeeds", async () => {
    const { fake, warnings, writer: w } = writer({ tagStateTtlSeconds: 60 });
    fake.failOn.set("hExpire", new Error("ERR unknown command 'HEXPIRE', with args beginning with: 'ns:_tagstate'"));
    await w.write(["a"], undefined);
    await w.write(["b"], undefined);
    expect(fake.count("hSet")).toBe(2);
    expect(fake.count("hExpire")).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/tagStateTtlSeconds needs Redis >= 7\.4/);
  });

  it("other HEXPIRE errors are ignored (best effort) and HEXPIRE is tried again next time", async () => {
    const { fake, warnings, writer: w } = writer({ tagStateTtlSeconds: 60 });
    fake.failOn.set("hExpire", new Error("READONLY You can't write against a read only replica"));
    await w.write(["a"], undefined);
    await w.write(["b"], undefined);
    expect(fake.count("hExpire")).toBe(2);
    expect(warnings).toEqual([]);
  });

  it("a failed HSET rejects (the handler reports it) and sends no HEXPIRE", async () => {
    const { fake, writer: w } = writer({ tagStateTtlSeconds: 60 });
    fake.failOn.set("hSet", new Error("OOM command not allowed"));
    await expect(w.write(["a"], undefined)).rejects.toThrow("OOM");
    expect(fake.count("hExpire")).toBe(0);
  });
});
