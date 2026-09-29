// Buffer serialization round-trip property: arbitrary binary data must survive base64 + JSON round-trips.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { convertStringsToBuffers, parseBuffersToStrings } from "../../src/buffer-utils";

const bytes = fc.uint8Array({ maxLength: 2048 }).map((a) => Buffer.from(a));

describe("buffer-utils round-trip", () => {
  it("APP_ROUTE body bytes are identical after a round-trip", () => {
    fc.assert(
      fc.property(bytes, (body) => {
        const value = { kind: "APP_ROUTE", body: Buffer.from(body) };
        parseBuffersToStrings(value);
        const restored = JSON.parse(JSON.stringify(value));
        convertStringsToBuffers(restored);
        expect(Buffer.isBuffer(restored.body)).toBe(true);
        expect(restored.body.equals(body)).toBe(true);
      }),
    );
  });

  it("APP_PAGE rscData and segmentData are identical after a JSON round-trip", () => {
    const segmentPath = fc.string({ minLength: 1, maxLength: 20 }).map((s) => "/" + s);
    const segments = fc.dictionary(segmentPath, bytes, { maxKeys: 8 });
    fc.assert(
      fc.property(bytes, segments, (rsc, segs) => {
        const value = {
          kind: "APP_PAGE",
          rscData: Buffer.from(rsc),
          segmentData: new Map(Object.entries(segs)),
        };
        parseBuffersToStrings(value);
        const restored = JSON.parse(JSON.stringify(value));
        convertStringsToBuffers(restored);
        expect(restored.rscData.equals(rsc)).toBe(true);
        const map = restored.segmentData as Map<string, Buffer>;
        expect([...map.keys()].sort()).toEqual(Object.keys(segs).sort());
        for (const [k, v] of Object.entries(segs)) expect(map.get(k)?.equals(v)).toBe(true);
      }),
    );
  });
});
