/**
 * A bounded `multipart/form-data` reader (RFC 7578) for the native publish routes (F-22): twine's
 * legacy upload and `swift package-registry publish` both send one.
 *
 * It parses an already-read, size-capped body (`body.ts` `readCappedBody`) in place: each part's
 * data is a view into the body, never a copy, so a 32 MiB upload costs the isolate 32 MiB once.
 * `Request.formData()` is not used because it buffers the parts again on top of the body. Part
 * headers are bounded (at most 8 KiB per part, at most `MAX_PARTS` parts), and anything that is
 * not well-formed multipart parses as `null`.
 */

import { Buffer } from "node:buffer";

/** One part of a form: its field name, its filename (a file field) and its bytes. */
export interface MultipartPart {
  readonly name: string;
  readonly filename: string | null;
  readonly contentType: string | null;
  /** A view into the request body. */
  readonly data: Uint8Array;
}

/** Twine sends about twenty fields; Swift four. */
const MAX_PARTS = 128;
const MAX_HEADER_BYTES = 8 * 1024;

/** The `boundary` parameter of a `multipart/form-data` content type, or `null`. */
export function multipartBoundary(contentType: string | null): string | null {
  if (contentType === null) return null;
  const [type, ...params] = contentType.split(";");
  if ((type ?? "").trim().toLowerCase() !== "multipart/form-data") return null;
  for (const p of params) {
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    if (p.slice(0, eq).trim().toLowerCase() !== "boundary") continue;
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2)
      v = v.slice(1, -1);
    // RFC 2046 §5.1.1: 1 to 70 characters.
    return v.length >= 1 && v.length <= 70 && !/[\r\n]/.test(v) ? v : null;
  }
  return null;
}

/** A `Content-Disposition` parameter (`name`, `filename`), unquoted. */
function dispositionParam(value: string, key: string): string | null {
  const re = new RegExp(
    `(?:^|;)\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`,
    "i",
  );
  const m = re.exec(value);
  if (!m) return null;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? null);
}

/**
 * Every part of `body`, in order, or `null` when it is not well-formed multipart for `boundary`
 * (no closing delimiter, a part without a `form-data` disposition or a name, too many parts, an
 * oversized header block).
 */
export function parseMultipart(
  body: Uint8Array,
  boundary: string,
): MultipartPart[] | null {
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const dash = Buffer.from(`--${boundary}`, "latin1");
  const delim = Buffer.from(`\r\n--${boundary}`, "latin1");
  // The first delimiter may open the body, or follow a preamble and a CRLF.
  let at: number;
  if (buf.subarray(0, dash.length).equals(dash)) at = 0;
  else {
    const i = buf.indexOf(delim);
    if (i === -1) return null;
    at = i + 2;
  }
  const parts: MultipartPart[] = [];
  for (;;) {
    let p = at + dash.length;
    // `--` after a delimiter closes the body.
    if (buf[p] === 0x2d && buf[p + 1] === 0x2d) return parts;
    // Transport padding (RFC 2046 §5.1.1), then CRLF.
    while (buf[p] === 0x20 || buf[p] === 0x09) p++;
    if (buf[p] !== 0x0d || buf[p + 1] !== 0x0a) return null;
    p += 2;
    const headerEnd = buf.indexOf("\r\n\r\n", p, "latin1");
    if (headerEnd === -1 || headerEnd - p > MAX_HEADER_BYTES) return null;
    const headers = new Map<string, string>();
    const headerText =
      headerEnd === p ? "" : buf.subarray(p, headerEnd).toString("utf8");
    for (const line of headerText === "" ? [] : headerText.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon <= 0) return null;
      headers.set(
        line.slice(0, colon).trim().toLowerCase(),
        line.slice(colon + 1).trim(),
      );
    }
    const dataStart = headerEnd + 4;
    const next = buf.indexOf(delim, dataStart);
    if (next === -1) return null;
    const disposition = headers.get("content-disposition") ?? "";
    if (!/^\s*form-data\s*(;|$)/i.test(disposition)) return null;
    const name = dispositionParam(disposition, "name");
    if (name === null || name === "") return null;
    parts.push({
      name,
      filename: dispositionParam(disposition, "filename"),
      contentType: headers.get("content-type") ?? null,
      data: body.subarray(dataStart, next),
    });
    if (parts.length > MAX_PARTS) return null;
    at = next + 2;
  }
}

/** The first part named `name`, or `undefined`. */
export function part(
  parts: readonly MultipartPart[],
  name: string,
): MultipartPart | undefined {
  return parts.find((p) => p.name === name);
}

/** A text field's value (UTF-8, at most `max` bytes), or `undefined` when absent or too long. */
export function field(
  parts: readonly MultipartPart[],
  name: string,
  max = 4 * 1024,
): string | undefined {
  const p = part(parts, name);
  if (!p || p.filename !== null || p.data.byteLength > max) return undefined;
  return new TextDecoder().decode(p.data);
}
