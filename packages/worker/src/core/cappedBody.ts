/**
 * The one way a route handler reads a request body.
 *
 * `req.text()` / `req.json()` / `req.arrayBuffer()` buffer the WHOLE body before any caller can
 * look at its size, and a chunked upload carries no `Content-Length` to pre-check, so a check on
 * the header or on the buffered length runs only after the isolate has already paid for the bytes.
 * These helpers count bytes as they stream and cancel the body the instant the cap is passed, so a
 * chunked body is rejected at the cap, before any HMAC or parse. The recurrence lint
 * (`test/cappedBodyLint.test.ts`) fails on a bare `req.text()` / `.json()` / `.arrayBuffer()` in
 * route code.
 */

/** Default cap for a small JSON/form body when a route has no tighter one. */
export const DEFAULT_BODY_CAP = 64 * 1024;

/** The body exceeded its cap. Carries no body content. */
export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** Read at most `maxBytes` of the request body; throws `BodyTooLargeError` past the cap. */
export async function readBodyBytes(
  req: Request,
  maxBytes: number = DEFAULT_BODY_CAP,
): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await req.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError(maxBytes);
  }
  const body = req.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
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
  return buf;
}

/** `readBodyBytes`, decoded as UTF-8. */
export async function readBodyText(
  req: Request,
  maxBytes: number = DEFAULT_BODY_CAP,
): Promise<string> {
  return new TextDecoder().decode(await readBodyBytes(req, maxBytes));
}

/** `readBodyText`, parsed as JSON (throws `SyntaxError` like `req.json()`). */
export async function readBodyJson(
  req: Request,
  maxBytes: number = DEFAULT_BODY_CAP,
): Promise<unknown> {
  return JSON.parse(await readBodyText(req, maxBytes));
}
