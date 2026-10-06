/**
 * `npm publish`'s request body, parsed without materialising the tarball as a string (F-22).
 *
 * npm (and pnpm, Yarn and Bun, through the same libnpmpublish shape) PUTs one JSON document:
 *
 *   { _id, name, description, "dist-tags": { <tag>: <version> },
 *     versions: { <version>: <the package.json, plus dist: { integrity, shasum, tarball }> },
 *     access, _attachments: { "<name>-<version>.tgz": { content_type, data: <base64>, length } } }
 *
 * `JSON.parse` over the whole body would hold the tarball three times (the body, the base64
 * string, the decoded bytes). Instead every JSON string longer than `LARGE_STRING_BYTES` is cut
 * out of the text before parsing and replaced by a short placeholder; the base64 is then decoded
 * straight from its byte range in the body. String boundaries are found with the one rule JSON
 * has for them (an unescaped `"`), so this needs no parser of its own. Only `_attachments.*.data`
 * may be large; a large string anywhere else is refused.
 */

/** Strings longer than this are cut out before `JSON.parse`. */
const LARGE_STRING_BYTES = 64 * 1024;
const PLACEHOLDER = "\u0000pkey-large:";

export interface NpmPublishBody {
  readonly doc: Record<string, unknown>;
  /** The decoded bytes of each attachment, by attachment name. */
  readonly attachments: ReadonlyMap<string, Uint8Array>;
}

export type NpmBodyResult =
  | { readonly ok: true; readonly body: NpmPublishBody }
  | { readonly ok: false; readonly message: string };

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/** Base64 alphabet → value; 255 = not base64. `\` is skipped (a JSON `\/` escape). */
const B64 = (() => {
  const t = new Uint8Array(256).fill(255);
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < a.length; i++) t[a.charCodeAt(i)] = i;
  return t;
})();

/** Decode the base64 between `start` and `end` (exclusive) of `bytes`, or `null`. */
function decodeBase64Range(
  bytes: Uint8Array,
  start: number,
  end: number,
): Uint8Array | null {
  // Count the significant characters first, so the output is allocated once.
  let n = 0;
  let pad = 0;
  for (let i = start; i < end; i++) {
    const c = bytes[i]!;
    if (c === BACKSLASH) continue;
    if (c === 0x3d) {
      pad++;
      continue;
    }
    if (pad > 0 || B64[c] === 255) return null;
    n++;
  }
  if (pad > 2 || (n + pad) % 4 !== 0 || n % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = start; i < end; i++) {
    const c = bytes[i]!;
    if (c === BACKSLASH || c === 0x3d) continue;
    acc = ((acc << 6) | B64[c]!) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === out.length ? out : null;
}

/** Parse an `npm publish` body (see the file comment). */
export function parseNpmPublishBody(bytes: Uint8Array): NpmBodyResult {
  const kept: Uint8Array[] = [];
  const large: { start: number; end: number }[] = [];
  let copyFrom = 0;
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    if (bytes[i] !== QUOTE) {
      i++;
      continue;
    }
    const open = i;
    i++;
    while (i < n && bytes[i] !== QUOTE) i += bytes[i] === BACKSLASH ? 2 : 1;
    if (i >= n) return { ok: false, message: "the body is not JSON" };
    const close = i;
    i++;
    if (close - open - 1 > LARGE_STRING_BYTES) {
      kept.push(bytes.subarray(copyFrom, open));
      kept.push(
        new TextEncoder().encode(JSON.stringify(PLACEHOLDER + large.length)),
      );
      large.push({ start: open + 1, end: close });
      copyFrom = close + 1;
    }
  }
  kept.push(bytes.subarray(copyFrom));
  const total = kept.reduce((a, b) => a + b.byteLength, 0);
  const small = new Uint8Array(total);
  let off = 0;
  for (const k of kept) {
    small.set(k, off);
    off += k.byteLength;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(small),
    );
  } catch {
    return { ok: false, message: "the body is not JSON" };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    return { ok: false, message: "the body is not a JSON object" };
  const d = doc as Record<string, unknown>;
  const attachments = new Map<string, Uint8Array>();
  const raw = d._attachments;
  const isLarge = (v: unknown): number | null =>
    typeof v === "string" && v.startsWith(PLACEHOLDER)
      ? Number(v.slice(PLACEHOLDER.length))
      : null;
  let usedLarge = 0;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [name, att] of Object.entries(raw as Record<string, unknown>)) {
      if (att === null || typeof att !== "object") continue;
      const data = (att as Record<string, unknown>).data;
      const idx = isLarge(data);
      let decoded: Uint8Array | null = null;
      if (idx !== null) {
        const r = large[idx];
        if (!r) return { ok: false, message: "the body is not JSON" };
        decoded = decodeBase64Range(bytes, r.start, r.end);
        usedLarge++;
      } else if (typeof data === "string") {
        const enc = new TextEncoder().encode(data);
        decoded = decodeBase64Range(enc, 0, enc.length);
      }
      if (decoded === null)
        return {
          ok: false,
          message: `_attachments["${name}"].data is not base64`,
        };
      attachments.set(name, decoded);
      (att as Record<string, unknown>).data = undefined;
    }
  }
  if (usedLarge !== large.length)
    return {
      ok: false,
      message: "only _attachments.*.data may carry a large value",
    };
  return { ok: true, body: { doc: d, attachments } };
}
