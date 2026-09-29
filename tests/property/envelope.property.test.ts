// Envelope round trip (ROADMAP.md 6.5 property layer): any Next.js cache value survives encode/decode,
// with and without compression.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decodeEnvelope, encodeEnvelope } from "../../src/envelope";

const bytes = fc.uint8Array({ maxLength: 4096 }).map((a) => Buffer.from(a));
const text = fc.oneof(fc.string({ maxLength: 40 }), fc.string({ minLength: 1000, maxLength: 3000 }));
const key = fc.oneof(fc.string({ maxLength: 12 }), fc.constant("$nrc"), fc.constant("__proto__"));

// JSON-like values plus Buffers and Maps, the shapes Next.js hands to the handlers
const { value } = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    text,
    bytes,
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(key, tie("value"), { maxKeys: 4 }),
    fc.array(fc.tuple(fc.string({ maxLength: 10 }), bytes), { maxLength: 4 }).map((entries) => new Map(entries)),
  ),
}));

describe("envelope round trip", () => {
  it.each(["none", "gzip", "brotli"] as const)("decode(encode(v)) equals v (compression %s)", async (compression) => {
    await fc.assert(
      fc.asyncProperty(value, fc.jsonValue(), async (v, meta) => {
        const decoded = await decodeEnvelope(await encodeEnvelope(meta, v, compression));
        expect(decoded.value).toEqual(v);
        expect(decoded.meta).toEqual(JSON.parse(JSON.stringify(meta ?? null)));
      }),
      { numRuns: compression === "none" ? 200 : 60 },
    );
  });
});
