/**
 * The request body of a native publish (F-22), read once and capped.
 *
 * A native client sends the package bytes in the request: npm as base64 inside JSON, twine and
 * SwiftPM as multipart, Maven as the raw file. Cloudflare bounds a request body by the zone's
 * plan (100 MB on Free and Pro); the Worker bounds it lower, at `NATIVE_PUBLISH_MAX_BODY_BYTES`,
 * because the body sits in the isolate's 128 MB of memory while it is parsed, hashed and staged.
 * The declared `Content-Length` is checked first (cheap rejection, before any byte is read) and
 * the streamed count enforces the cap, so an absent or lying length cannot stretch it. A larger
 * package publishes through `pkey release publish`, whose bytes go straight to R2.
 */

/** The largest native publish request body: 32 MiB. */
export const NATIVE_PUBLISH_MAX_BODY_BYTES = 32 * 1024 * 1024;

export type CappedBody =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "too-large" | "unreadable" };

/** Read `req`'s body, at most `max` bytes. */
export async function readCappedBody(
  req: Request,
  max = NATIVE_PUBLISH_MAX_BODY_BYTES,
): Promise<CappedBody> {
  const lengthHeader = req.headers.get("content-length");
  const declared = lengthHeader === null ? NaN : Number(lengthHeader);
  if (Number.isFinite(declared) && declared > max) {
    await req.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "too-large" };
  }
  const body = req.body;
  if (!body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  // With a declared length the bytes are copied straight into one buffer of that size, so the
  // body is held once, not twice (chunks, then their concatenation).
  const sized =
    Number.isSafeInteger(declared) && declared > 0
      ? new Uint8Array(declared)
      : null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > max) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      if (sized) {
        // A body longer than it declared is malformed; the runtime refuses it too.
        if (total + value.byteLength > sized.byteLength)
          return { ok: false, reason: "unreadable" };
        sized.set(value, total);
      } else chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    reader.releaseLock();
  }
  if (sized)
    return total === sized.byteLength
      ? { ok: true, bytes: sized }
      : { ok: false, reason: "unreadable" };
  if (chunks.length === 1) return { ok: true, bytes: chunks[0]! };
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, bytes };
}
