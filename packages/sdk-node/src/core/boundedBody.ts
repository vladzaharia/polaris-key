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
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (res.body === null) return "";
  const parts: Buffer[] = [];
  let total = 0;
  // Leaving the loop cancels the stream, so an endless body is not read on.
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) return null;
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts).toString("utf8");
}
