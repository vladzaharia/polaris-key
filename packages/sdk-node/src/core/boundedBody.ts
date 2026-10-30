// A response body read under a byte cap. `content-length` is checked first; the stream is then
// read with a running count of BYTES (not string length) and cancelled the moment it passes the
// cap, so a hostile server cannot make the client buffer more than `max` bytes.

/** The most bytes the SDK reads from a Cloud Sync or catalog answer. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** The body as text, or null when it is larger than `max` bytes. */
export async function readCappedText(
  res: Response,
  max: number = MAX_BODY_BYTES,
): Promise<string | null> {
  const bytes = await readCappedBytes(res, max);
  return bytes === null ? null : Buffer.from(bytes).toString("utf8");
}

/**
 * The body as bytes, or null when it is larger than `max` bytes (or `content-length` says so).
 * The stream is counted in bytes and cancelled on the first byte past the cap.
 */
export async function readCappedBytes(
  res: Response,
  max: number,
): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (res.body === null) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) return null;
    parts.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
