/**
 * The bounds on what pkey reads from a server (N1, N3): one 64 KiB cap on a body and one
 * deadline on a request, shared by every command that talks to the console API. This module
 * imports nothing, so `account.ts`, `bundle.ts`, `adminAuth.ts` and `doctor.ts` can all take it
 * without an import cycle.
 */

/** A request that has not answered in this long is a network failure (N3). */
export const REQUEST_TIMEOUT_MS = 15_000;

/** The most of a response pkey reads (N1). */
export const MAX_JSON_BYTES = 64 * 1024;

/**
 * A response body as text, read through the cap: a body past `MAX_JSON_BYTES` (a host that
 * streams without end, or a proxy's error page) is `null` and the rest is never read. A body
 * that cannot be read at all is `null` too.
 */
export async function readCappedText(
  res: Response,
  max: number = MAX_JSON_BYTES,
): Promise<string | null> {
  try {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > max) {
      void res.body?.cancel().catch(() => undefined);
      return null;
    }
    const reader = res.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

/** A body as a JSON object through the cap; anything else (too big, not JSON, an array) is `{}`. */
export async function readCappedJson(
  res: Response,
  max: number = MAX_JSON_BYTES,
): Promise<Record<string, unknown>> {
  const text = await readCappedText(res, max);
  if (text === null) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
