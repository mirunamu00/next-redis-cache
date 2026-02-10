/**
 * Buffer <-> base64 serialization for legacy cacheHandler (singular).
 *
 * Next.js stores APP_PAGE rscData/segmentData and APP_ROUTE body as Buffers.
 * Redis can only store strings, so we convert Buffers to base64 before storing
 * and restore them on retrieval.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseBuffersToStrings(value: any): void {
  if (!value) return;

  const kind = value.kind as string | undefined;

  if (kind === "APP_ROUTE") {
    if (value.body && Buffer.isBuffer(value.body)) {
      value.body = value.body.toString("base64");
    }
  } else if (kind === "APP_PAGE") {
    if (value.rscData && Buffer.isBuffer(value.rscData)) {
      value.rscData = value.rscData.toString("base64");
    }
    if (value.segmentData instanceof Map) {
      const entries = value.segmentData as Map<string, Buffer>;
      value.segmentData = Object.fromEntries(
        [...entries.entries()].map(([key, val]) => [key, val.toString("base64")])
      );
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertStringsToBuffers(value: any): void {
  if (!value) return;

  const kind = value.kind as string | undefined;

  if (kind === "APP_ROUTE") {
    if (typeof value.body === "string") {
      value.body = Buffer.from(value.body, "base64");
    }
  } else if (kind === "APP_PAGE") {
    if (typeof value.rscData === "string") {
      value.rscData = Buffer.from(value.rscData, "base64");
    }
    if (value.segmentData && !(value.segmentData instanceof Map)) {
      value.segmentData = new Map(
        Object.entries(value.segmentData).map(([key, val]) => [
          key,
          Buffer.from(val as string, "base64"),
        ])
      );
    }
  }
}
