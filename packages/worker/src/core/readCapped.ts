/**
 * Read at most `maxBytes` of a response body as UTF-8, cancelling the stream the moment the cap
 * is passed (R10-15, R7-02; P5-04 for the store clients). The declared `Content-Length` is checked
 * first (cheap rejection), but the streamed accounting is what enforces the cap — an absent or
 * lying `Content-Length` must not be able to bypass it.
 *
 * `tooLarge` builds the caller's error from a detail string (`"123 bytes"`, `">4096 bytes"`), so
 * each caller keeps its own error type and never echoes the body.
 */
export async function readCappedText(
  res: Response,
  maxBytes: number,
  tooLarge: (detail: string) => Error,
): Promise<string> {
  const declared = Number(res.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge(`${declared} bytes`);
  }
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge(`>${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}
