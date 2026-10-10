/**
 * Magic-number content sniffing (S-20 §6.3 step 3; HA-01).
 *
 * The type of a stored or hosted object comes from its first bytes, never from what a sender
 * declared: an upstream `Content-Type`, a CI upload's header and a file name are all claims. The
 * answer is one of a short list of INERT types (raster images and MP4), or
 * `application/octet-stream` for everything else.
 *
 * SVG and HTML are never recognised. Both are documents that can carry script, so there is no
 * branch here that could ever answer `image/svg+xml` or `text/html`, whatever the bytes are.
 * `test/sniff.test.ts` pins that.
 */

/** How many leading bytes `sniffContentType` reads. Callers peek at least this many. */
export const SNIFF_BYTES = 32;

/** The raster image types a hosted image may be. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

/** The video type a hosted video may be (HA-17). */
export const VIDEO_TYPES: ReadonlySet<string> = new Set(["video/mp4"]);

/** ISO-BMFF major brands read as MP4 video. HEIC and others answer octet-stream. */
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "dash",
  "M4V ",
]);

/** ISO-BMFF major brands read as AVIF (an image sequence included). */
const AVIF_BRANDS = new Set(["avif", "avis"]);

function ascii(b: Uint8Array, from: number, to: number): string {
  let out = "";
  for (let i = from; i < to && i < b.length; i++)
    out += String.fromCharCode(b[i]!);
  return out;
}

/**
 * The content type of an object whose first bytes are `head` (pass at least `SNIFF_BYTES`, or
 * the whole object when it is shorter). Never SVG, never HTML.
 */
export function sniffContentType(head: Uint8Array): string {
  const at = (i: number, ...sig: number[]) =>
    sig.every((v, k) => head[i + k] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP")
    return "image/webp";
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a")
    return "image/gif";
  if (ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (AVIF_BRANDS.has(brand)) return "image/avif";
    if (MP4_BRANDS.has(brand)) return "video/mp4";
  }
  return "application/octet-stream";
}

/**
 * Read the first `n` bytes of `body` without losing them: answers those bytes and a stream that
 * yields the WHOLE body again, from the first byte. Nothing beyond the chunks needed to reach `n`
 * is read, so a large body stays streamed.
 */
export async function peekStream(
  body: ReadableStream,
  n: number = SNIFF_BYTES,
): Promise<{ head: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const pending: Uint8Array[] = [];
  let have = 0;
  let done = false;
  while (have < n) {
    const r = await reader.read();
    if (r.done) {
      done = true;
      break;
    }
    const chunk = toBytes(r.value);
    pending.push(chunk);
    have += chunk.byteLength;
  }
  const head = new Uint8Array(Math.min(have, n));
  let off = 0;
  for (const c of pending) {
    if (off >= head.length) break;
    const take = c.subarray(0, head.length - off);
    head.set(take, off);
    off += take.byteLength;
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = pending.shift();
      if (next) {
        controller.enqueue(next);
        return;
      }
      if (done) {
        controller.close();
        return;
      }
      const r = await reader.read();
      if (r.done) controller.close();
      else controller.enqueue(toBytes(r.value));
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { head, stream };
}

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v))
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError("stream chunk is not bytes");
}
