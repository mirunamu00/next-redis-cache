/**
 * ReadableStream <-> Buffer serialization for use-cache handler (cacheHandlers plural).
 *
 * The new `use cache` API uses ReadableStream<Uint8Array> for cache entry values.
 * We consume the stream to a Buffer for Redis storage, and restore it on retrieval.
 */

export async function streamToBuffer(
  stream: ReadableStream<Uint8Array>
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

export function bufferToStream(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}
