// Binary entry format (ROADMAP.md 5.1): raw bytes instead of base64, Maps and large strings as blobs,
// optional compression, and anything that is not this format is rejected (a miss for the handlers).
import { describe, expect, it } from "vitest";
import { COMPRESS_MIN_BYTES, decodeEnvelope, encodeEnvelope, EnvelopeFormatError, ENVELOPE_VERSION, isEnvelope } from "../../src/envelope";

const page = () => ({
  kind: "APP_PAGE",
  html: "<html>" + "x".repeat(5000) + "</html>",
  rscData: Buffer.from([0, 1, 2, 255]),
  headers: { "x-next-cache-tags": "a,b" },
  postponed: undefined,
  status: 404,
  segmentData: new Map([
    ["/_tree", Buffer.from("tree")],
    ["/about/__PAGE__", Buffer.from("page")],
  ]),
});

describe("envelope", () => {
  it("round-trips an APP_PAGE value with Buffers, a Map and a large string", async () => {
    const raw = await encodeEnvelope({ lastModified: 1, tags: ["a"] }, page());
    expect(isEnvelope(raw)).toBe(true);
    const { meta, value } = await decodeEnvelope<{ lastModified: number; tags: string[] }>(raw);
    expect(meta).toEqual({ lastModified: 1, tags: ["a"] });
    const v = value as ReturnType<typeof page>;
    expect(v.html).toBe(page().html);
    expect(Buffer.isBuffer(v.rscData) && v.rscData.equals(Buffer.from([0, 1, 2, 255]))).toBe(true);
    expect(v.segmentData).toBeInstanceOf(Map);
    expect(v.segmentData.get("/about/__PAGE__")?.toString()).toBe("page");
    expect("postponed" in v).toBe(false);
    expect(v.status).toBe(404);
  });

  it("stores bytes raw (no base64, no JSON escaping of large strings)", async () => {
    const body = Buffer.alloc(30_000, 7);
    const html = '"quoted"'.repeat(2000);
    const raw = await encodeEnvelope({}, { kind: "APP_ROUTE", body, html });
    expect(raw.byteLength).toBeLessThan(body.byteLength + Buffer.byteLength(html) + 200);
  });

  it("keeps user objects that happen to use the marker key", async () => {
    const value = { data: { $nrc: "b", i: 0, other: [1, "two", null, { $nrc: "s" }] } };
    const { value: out } = await decodeEnvelope(await encodeEnvelope(null, value));
    expect(out).toEqual(value);
  });

  it("turns a Uint8Array into a Buffer with the same bytes", async () => {
    const { value } = await decodeEnvelope(await encodeEnvelope(null, new Uint8Array([9, 8, 7])));
    expect(Buffer.isBuffer(value) && [...(value as Buffer)]).toEqual([9, 8, 7]);
  });

  it.each(["gzip", "brotli"] as const)("compresses large payloads with %s and restores them", async (compression) => {
    const value = page();
    const plain = await encodeEnvelope({ n: 1 }, value);
    const packed = await encodeEnvelope({ n: 1 }, value, compression);
    expect(packed.byteLength).toBeLessThan(plain.byteLength / 3);
    expect(packed[4]).not.toBe(0);
    const { meta, value: out } = await decodeEnvelope(packed);
    expect(meta).toEqual({ n: 1 });
    expect((out as { html: string }).html).toBe(value.html);
  });

  it("leaves payloads below the threshold uncompressed", async () => {
    const raw = await encodeEnvelope({}, "small", "gzip");
    expect(raw.byteLength).toBeLessThan(COMPRESS_MIN_BYTES);
    expect(raw[4]).toBe(0);
  });

  it.each([
    ["1.x JSON", Buffer.from(JSON.stringify({ lastModified: 1, value: {} }))],
    ["another format version", Buffer.from([0x4e, 0x52, 0x43, ENVELOPE_VERSION + 1, 0, 0, 0, 0, 2, 123, 125])],
    ["truncated", Buffer.from([0x4e, 0x52, 0x43, ENVELOPE_VERSION, 0, 0, 0, 1])],
    ["bad compression", Buffer.from([0x4e, 0x52, 0x43, ENVELOPE_VERSION, 1, 1, 2, 3])],
    ["unknown flag", Buffer.from([0x4e, 0x52, 0x43, ENVELOPE_VERSION, 3, 0, 0, 0, 2, 123, 125])],
    ["broken meta", Buffer.from([0x4e, 0x52, 0x43, ENVELOPE_VERSION, 0, 0, 0, 0, 2, 123, 123])],
  ])("rejects %s with EnvelopeFormatError", async (_name, raw) => {
    await expect(decodeEnvelope(raw)).rejects.toBeInstanceOf(EnvelopeFormatError);
  });

  // Found by the property test (a dictionary with the key "__proto__"): assigning out["__proto__"] sets the
  // prototype of the copy instead of an own property, so the key was lost on the way in and on the way out
  it("keeps an own \"__proto__\" key as data (and never as the prototype)", async () => {
    const value = JSON.parse('{"a":1,"__proto__":{"polluted":true},"list":[{"__proto__":null}]}') as Record<string, unknown>;
    const { value: out } = (await decodeEnvelope(await encodeEnvelope({}, value))) as { value: Record<string, unknown> };
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.keys(out)).toEqual(["a", "__proto__", "list"]);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({ polluted: true });
    expect(out).toEqual(value);
  });

  it("rejects a blob reference that is out of range", async () => {
    const meta = Buffer.from(JSON.stringify({ m: null, v: { $nrc: "b", i: 3 }, b: [] }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(meta.byteLength);
    const raw = Buffer.concat([Buffer.from([0x4e, 0x52, 0x43, ENVELOPE_VERSION, 0]), len, meta]);
    await expect(decodeEnvelope(raw)).rejects.toBeInstanceOf(EnvelopeFormatError);
  });
});
