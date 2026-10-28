// A response body read under a byte cap, as sdk-node's `core/boundedBody.ts`. `content-length` is
// checked first; the stream is then read with a running count of BYTES (not string length) and
// cancelled the moment it passes the cap, so a hostile server cannot make the page buffer more
// than `max` bytes.

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
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}
