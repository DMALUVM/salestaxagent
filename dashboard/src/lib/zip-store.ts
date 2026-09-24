/**
 * ZIP builder for the GNO pack. Entries are deflated (method 8) when that
 * is smaller than stored bytes. CSV packs are highly repetitive; a STORE-only
 * zip of the live negatives snapshot plus the #176 files crosses Vercel's
 * 4.5MB buffered response cap, and the browser then never receives a file.
 * zlib is built into Node — no extra dependency.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff);
}

function u32(n: number): Uint8Array {
  return Uint8Array.of(
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export interface ZipEntry {
  name: string;
  body: string;
}

/** Build a .zip of UTF-8 text files. Deflate when it shrinks the entry. */
export function zipStore(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = encoder.encode(entry.body);
    const compressed = raw.length > 0 ? deflateRawSync(raw) : raw;
    const deflate = compressed.length > 0 && compressed.length < raw.length;
    const data = deflate ? compressed : raw;
    const method = deflate ? 8 : 0;
    const crc = crc32(raw);
    const local = concat([
      Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    locals.push(local);
    centrals.push(concat([
      Uint8Array.of(0x50, 0x4b, 0x01, 0x02),
      u16(20),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]));
    offset += local.length;
  }

  const central = concat(centrals);
  const eocd = concat([
    Uint8Array.of(0x50, 0x4b, 0x05, 0x06),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return concat([...locals, central, eocd]);
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

/** Read back entries written by zipStore. Used to prove the bytes are a real zip. */
export function unzipStore(zip: Uint8Array): ZipEntry[] {
  const out: ZipEntry[] = [];
  let offset = 0;
  const decoder = new TextDecoder();
  while (offset + 30 <= zip.length && readU32(zip, offset) === 0x04034b50) {
    const method = readU16(zip, offset + 8);
    const compSize = readU32(zip, offset + 18);
    const nameLen = readU16(zip, offset + 26);
    const extraLen = readU16(zip, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = decoder.decode(zip.subarray(nameStart, nameStart + nameLen));
    const data = zip.subarray(dataStart, dataStart + compSize);
    const raw = method === 0 ? data : inflateRawSync(data);
    out.push({ name, body: decoder.decode(raw) });
    offset = dataStart + compSize;
  }
  return out;
}

/**
 * Chunked attachment response. Omits Content-Length so the platform sends
 * a streamed body. A single buffered Buffer over 4.5MB is rejected after
 * the function has already logged 200, and the browser saves nothing.
 */
export function zipAttachmentResponse(
  bytes: Uint8Array,
  filename: string,
  extraHeaders?: Record<string, string>,
): Response {
  const payload = bytes.slice();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const size = 64 * 1024;
      for (let i = 0; i < payload.length; i += size) {
        controller.enqueue(payload.slice(i, Math.min(i + size, payload.length)));
      }
      controller.close();
    },
  });
  const safeName = filename.replace(/["\r\n]/g, "");
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${safeName}"`,
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

/**
 * Transport framing for a zip whose bytes are not ready yet.
 * Leading 0x00 heartbeats keep the socket alive; the client strips them.
 * The zip itself still starts with PK\x03\x04. A build failure is the
 * UTF-8 text `GNOERR:` plus the message, after those heartbeats.
 */
export const ZIP_FRAMING_NUL_HEARTBEAT = "nul-heartbeat";

const HEARTBEAT = Uint8Array.of(0);
const GNOERR_PREFIX = "GNOERR:";

function pulse(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * Return a zip attachment whose first body byte is written before `produce`
 * resolves. Next flushes response headers only when the first chunk is
 * written, so a stream that stays empty during a long pack build is dropped
 * by the browser (`Failed to fetch`) with no serverless completion.
 */
export function streamingZipResponse(
  filename: string,
  produce: () => Promise<Uint8Array>,
  opts?: { heartbeatMs?: number; extraHeaders?: Record<string, string> },
): Response {
  const heartbeatMs = opts?.heartbeatMs ?? 2_000;
  const safeName = filename.replace(/["\r\n]/g, "");
  let started = false;
  let zip: Uint8Array | null = null;
  let failure: string | null = null;
  let offset = 0;
  let producePromise: Promise<void> | null = null;
  let beat: ReturnType<typeof pulse> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        console.info("gno-export stream open", safeName);
        producePromise = Promise.resolve().then(produce).then(
          (bytes) => {
            zip = bytes;
            console.info("gno-export zip bytes", bytes.length, safeName);
          },
          (err: unknown) => {
            failure = err instanceof Error ? err.message : String(err);
            console.error("gno-export build failed", err);
          },
        );
        controller.enqueue(HEARTBEAT);
        return;
      }

      if (zip == null && failure == null) {
        beat = pulse(heartbeatMs);
        await Promise.race([producePromise, beat.promise]);
        beat.cancel();
        beat = null;
        if (zip == null && failure == null) {
          controller.enqueue(HEARTBEAT);
          return;
        }
      }

      if (failure != null) {
        controller.enqueue(new TextEncoder().encode(`${GNOERR_PREFIX}${failure}`));
        controller.close();
        return;
      }

      if (zip == null || offset >= zip.length) {
        controller.close();
        return;
      }

      const end = Math.min(offset + 64 * 1024, zip.length);
      controller.enqueue(zip.subarray(offset, end));
      offset = end;
      if (offset >= zip.length) controller.close();
    },
    cancel() {
      beat?.cancel();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${safeName}"`,
      "cache-control": "no-store",
      "x-gno-zip-framing": ZIP_FRAMING_NUL_HEARTBEAT,
      ...opts?.extraHeaders,
    },
  });
}
