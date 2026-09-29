// use-cache handler ReadableStream <-> Buffer conversion: pins 1.0.6 behavior.
import { describe, expect, it } from "vitest";
import { bufferToStream, streamToBuffer } from "../../src/stream-utils";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

describe("streamToBuffer", () => {
  it("concatenates chunks in order", async () => {
    const buf = await streamToBuffer(streamOf([Buffer.from("ab"), Buffer.from("cd"), Buffer.from("e")]));
    expect(buf.toString()).toBe("abcde");
  });

  it("returns an empty Buffer for an empty stream", async () => {
    const buf = await streamToBuffer(streamOf([]));
    expect(buf.byteLength).toBe(0);
  });
});

describe("bufferToStream", () => {
  it("emits a single chunk and closes (round-trip preserved)", async () => {
    const original = Buffer.from([0, 1, 2, 250, 255]);
    const roundTrip = await streamToBuffer(bufferToStream(original));
    expect(roundTrip.equals(original)).toBe(true);
  });
});
