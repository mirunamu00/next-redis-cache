/**
 * Binary storage format of cache entries (ROADMAP.md section 5.1).
 *
 *   header   "NRC" (3 bytes) | format version (1 byte) | flags (1 byte: bits 0-1 = compression)
 *   body     uint32 BE meta length | meta JSON (UTF-8) | blob 0 | blob 1 | ...   (compressed as a whole)
 *
 * Meta JSON is `{ m: <metadata>, v: <value>, b: [<blob lengths>] }`. Inside `v`, Buffers and
 * Uint8Arrays become `{"$nrc":"b","i":n}` (raw bytes, no base64), Maps become
 * `{"$nrc":"m","e":[[k,v],...]}`, strings of 1 KiB and more become `{"$nrc":"s","i":n}` (UTF-8 bytes,
 * no JSON escaping), and an object that already has a "$nrc" key is wrapped as `{"$nrc":"o","v":...}`.
 * Decoding restores the same value (a Uint8Array comes back as a Buffer). Anything that is not this
 * format (another version, 1.x JSON, garbage) is rejected with EnvelopeFormatError, which the
 * handlers treat as a miss.
 */
import { promisify } from "node:util";
import zlib from "node:zlib";
import type { Compression } from "./types";

export const ENVELOPE_VERSION = 1;
const MAGIC = Buffer.from("NRC", "latin1");
const HEADER_LENGTH = 5;
const LARGE_STRING = 1024;
/** Payloads smaller than this are stored uncompressed even when compression is on. */
export const COMPRESS_MIN_BYTES = 1024;

const COMPRESSION_FLAG: Record<Compression, number> = { none: 0, gzip: 1, brotli: 2 };

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

/** Brotli quality 4: close to gzip speed with better ratios; the default (11) is far too slow per request. */
const BROTLI_OPTIONS = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } };

export class EnvelopeFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeFormatError";
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function pack(value: unknown, blobs: Buffer[]): Json {
  if (Buffer.isBuffer(value)) {
    blobs.push(value);
    return { $nrc: "b", i: blobs.length - 1 };
  }
  if (value instanceof Uint8Array) {
    blobs.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    return { $nrc: "b", i: blobs.length - 1 };
  }
  if (typeof value === "string") {
    if (value.length < LARGE_STRING) return value;
    blobs.push(Buffer.from(value, "utf8"));
    return { $nrc: "s", i: blobs.length - 1 };
  }
  if (value instanceof Map) {
    return { $nrc: "m", e: [...value].map(([k, v]) => [pack(k, blobs), pack(v, blobs)]) };
  }
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : pack(v, blobs)));
  if (value !== null && typeof value === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || typeof v === "function") continue;
      out[k] = pack(v, blobs);
    }
    return Object.prototype.hasOwnProperty.call(value, "$nrc") ? { $nrc: "o", v: out } : out;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return null; // undefined, bigint, symbol: not part of Next.js cache values
}

function unpack(value: Json, blobs: Buffer[]): unknown {
  if (Array.isArray(value)) return value.map((v) => unpack(v, blobs));
  if (value === null || typeof value !== "object") return value;
  const marker = (value as { $nrc?: Json }).$nrc;
  if (marker !== undefined) {
    const blob = (i: Json) => {
      const b = typeof i === "number" ? blobs[i] : undefined;
      if (!b) throw new EnvelopeFormatError(`missing blob ${String(i)}`);
      return b;
    };
    switch (marker) {
      case "b":
        return blob(value.i as Json);
      case "s":
        return blob(value.i as Json).toString("utf8");
      case "m":
        return new Map((value.e as Json[][]).map(([k, v]) => [unpack(k as Json, blobs), unpack(v as Json, blobs)]));
      case "o":
        return unpackObject(value.v as { [k: string]: Json }, blobs);
      default:
        throw new EnvelopeFormatError(`unknown marker ${String(marker)}`);
    }
  }
  return unpackObject(value, blobs);
}

function unpackObject(value: { [k: string]: Json }, blobs: Buffer[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = unpack(v, blobs);
  return out;
}

export interface Envelope<M> {
  meta: M;
  value: unknown;
}

/** Serializes `meta` (plain JSON) and `value` (any Next.js cache value) into one Buffer. */
export async function encodeEnvelope<M>(meta: M, value: unknown, compression: Compression = "none"): Promise<Buffer> {
  const blobs: Buffer[] = [];
  const v = pack(value, blobs);
  const metaJson = Buffer.from(JSON.stringify({ m: meta, v, b: blobs.map((b) => b.byteLength) }), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(metaJson.byteLength, 0);
  let body = Buffer.concat([length, metaJson, ...blobs]);
  let flag = 0;
  if (compression !== "none" && body.byteLength >= COMPRESS_MIN_BYTES) {
    body = compression === "gzip" ? await gzip(body) : await brotliCompress(body, BROTLI_OPTIONS);
    flag = COMPRESSION_FLAG[compression];
  }
  const header = Buffer.from([...MAGIC, ENVELOPE_VERSION, flag]);
  return Buffer.concat([header, body]);
}

/** True when `raw` starts with this format's magic (any version). */
export function isEnvelope(raw: Buffer): boolean {
  return raw.byteLength >= HEADER_LENGTH && raw.subarray(0, 3).equals(MAGIC);
}

export async function decodeEnvelope<M>(raw: Buffer): Promise<Envelope<M>> {
  if (!Buffer.isBuffer(raw) || !isEnvelope(raw)) throw new EnvelopeFormatError("not a next-redis-cache 2.x entry");
  const version = raw[3];
  if (version !== ENVELOPE_VERSION) throw new EnvelopeFormatError(`unsupported entry format version ${String(version)}`);
  const flag = raw[4]! & 0b11;
  let body = raw.subarray(HEADER_LENGTH);
  try {
    if (flag === 1) body = await gunzip(body);
    else if (flag === 2) body = await brotliDecompress(body);
    else if (flag !== 0) throw new EnvelopeFormatError(`unknown compression flag ${flag}`);
  } catch (err) {
    if (err instanceof EnvelopeFormatError) throw err;
    throw new EnvelopeFormatError(`corrupted compressed entry: ${(err as Error).message}`);
  }
  if (body.byteLength < 4) throw new EnvelopeFormatError("truncated entry");
  const metaLength = body.readUInt32BE(0);
  if (4 + metaLength > body.byteLength) throw new EnvelopeFormatError("truncated entry");
  let parsed: { m: M; v: Json; b: number[] };
  try {
    parsed = JSON.parse(body.subarray(4, 4 + metaLength).toString("utf8"));
  } catch {
    throw new EnvelopeFormatError("corrupted entry metadata");
  }
  const blobs: Buffer[] = [];
  let offset = 4 + metaLength;
  for (const len of parsed.b ?? []) {
    if (typeof len !== "number" || offset + len > body.byteLength) throw new EnvelopeFormatError("truncated entry");
    blobs.push(body.subarray(offset, offset + len));
    offset += len;
  }
  return { meta: parsed.m, value: unpack(parsed.v, blobs) };
}
