/**
 * Compression Dictionary Transport for the payload URL (P4-18; RFC 9842; notes/A7 §9.3): the pure
 * half, with no imports, so the Chromium harness in `conformance/runners/browser` serves exactly
 * the bytes and header values the Worker does.
 *
 * The payload URL serves a pack's DECODED container payload to a browser: the stored `full`
 * frame streamed with `Content-Encoding: zstd`. The browser keeps that response as a dictionary
 * (`Use-As-Dictionary`), and on the next update offers it back (`Available-Dictionary`, the
 * SHA-256 of the dictionary, which is the base payload's `payload.sha256`, a delta's `from`). The
 * Worker then answers `Content-Encoding: dcz`: the 8-byte dcz magic, the 32-byte SHA-256 of the
 * dictionary, and the stored `zstd --patch-from` artifact, unchanged. The header is derived from
 * `from` alone: no base bytes are read, and the stored artifact stays the portable bare frame
 * (A7 §7.3: most decoders mishandle a dcz body).
 */

/** The dcz stream's magic (RFC 9842 §4.2): a zstd skippable frame header with a 32-byte body. */
export const DCZ_MAGIC = Uint8Array.of(0x5e, 0x2a, 0x4d, 0x18, 0x20, 0, 0, 0);
/** The dcz header's length: the magic and the dictionary's SHA-256. */
export const DCZ_HEADER_BYTES = 40;

/** Chromium never offers a dictionary over 100 MiB (`kDictionarySizeLimit`; A7 §9.3 measured
 *  104,857,600 B offered and one byte more not), so none is advertised above it. */
export const MAX_DICTIONARY_BYTES = 100 * 1024 * 1024;

/** Every answer of the payload URL varies on both. */
export const PAYLOAD_VARY = "Accept-Encoding, Available-Dictionary";

/**
 * The SDK's guard against a silent full download (`?via=dcz`): with it, a request the Worker
 * cannot answer with dcz (no `Available-Dictionary`, another base, no `dcz` in
 * `Accept-Encoding`) is `409` with no body, and the SDK takes the WASM delta instead.
 */
export const DCZ_GUARD = { param: "via", value: "dcz" } as const;

/** The variant segment of the payload URL: a variant key (`axis=value;…`), or `default`. */
const VARIANT_SEGMENT =
  /^(?:default|[a-z][a-z0-9-]{0,15}=[A-Za-z0-9][A-Za-z0-9-]{0,34}(?:;[a-z][a-z0-9-]{0,15}=[A-Za-z0-9][A-Za-z0-9-]{0,34}){0,3})$/;
/** A pack id (`DELIVERABLE_ID_PATTERN`, at most 64 bytes, never `app`). */
const PACK_SEGMENT = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/;

/** Whether `segment` is a payload URL's variant segment (a build id). */
export function isVariantSegment(segment: string): boolean {
  return VARIANT_SEGMENT.test(segment);
}

/** Whether `segment` is a payload URL's pack segment. */
export function isPackSegment(segment: string): boolean {
  return (
    segment.length <= 64 && segment !== "app" && PACK_SEGMENT.test(segment)
  );
}

/** The payload URL's path, after the origin: `/<p>/distribution/packs/<pack>/<variant>/payload/<sha256>`. */
export function payloadPath(
  product: string,
  packId: string,
  buildId: string,
  payloadSha256: string,
): string {
  return `${dictionaryPrefix(product, packId, buildId)}${payloadSha256}`;
}

/** Every payload URL of one (pack, variant) starts with this. */
export function dictionaryPrefix(
  product: string,
  packId: string,
  buildId: string,
): string {
  return `/${product}/distribution/packs/${packId}/${buildId}/payload/`;
}

/**
 * The `Use-As-Dictionary` value for one (pack, variant): a match pattern covering exactly its
 * payload URLs. RFC 9842 has the browser pick the dictionary with the LONGEST matching pattern,
 * then the most recent, so a product-wide pattern would offer another pack's payload. Every
 * character of the prefix is outside URLPattern's syntax characters (`:*(){}?+\`), and none
 * needs escaping in an sf-string. `match-dest=("")` keeps it to `fetch()` and XHR.
 */
export function useAsDictionary(
  product: string,
  packId: string,
  buildId: string,
): string {
  return `match="${dictionaryPrefix(product, packId, buildId)}*", match-dest=("")`;
}

/** The dcz header for a dictionary whose SHA-256 is `fromHex`. */
export function dczHeader(fromHex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(fromHex)) throw new Error("dcz: not a SHA-256");
  const out = new Uint8Array(DCZ_HEADER_BYTES);
  out.set(DCZ_MAGIC, 0);
  for (let i = 0; i < 32; i++)
    out[8 + i] = parseInt(fromHex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * `Available-Dictionary` (an sf-binary, `:<base64>:`) as lowercase hex, or null when it is absent
 * or is not the 32-byte SHA-256 the RFC requires.
 */
export function parseAvailableDictionary(value: string | null): string | null {
  if (value === null) return null;
  const m = /^\s*:([A-Za-z0-9+/]*={0,2}):\s*$/.exec(value);
  if (!m) return null;
  let bin: string;
  try {
    bin = atob(m[1] as string);
  } catch {
    return null;
  }
  if (bin.length !== 32) return null;
  let hex = "";
  for (let i = 0; i < bin.length; i++)
    hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

/** Whether `Accept-Encoding` accepts `coding` (a listed token whose `q` is not 0; `*` counts). */
export function acceptsEncoding(value: string | null, coding: string): boolean {
  if (value === null) return false;
  let star = false;
  for (const part of value.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split("=");
      if (k === "q") q = Number(v);
    }
    if (!(q > 0)) {
      if (name === coding) return false;
      continue;
    }
    if (name === coding) return true;
    if (name === "*") star = true;
  }
  return star;
}

/** What the payload URL answers one request with. */
export type PayloadAnswer =
  /** `Content-Encoding: dcz`: the header for `from`, then the delta's stored artifact. */
  | { kind: "dcz"; from: string; artifact: { sha256: string; bytes: number } }
  /** The stored `full`: with `Content-Encoding: zstd`, or raw for `codec: none`. */
  | { kind: "full"; encoding: "zstd" | null }
  /** `406`: a zstd `full` and no `zstd` in `Accept-Encoding`. `409`: the dcz guard missed. */
  | { kind: "refuse"; status: 406 | 409 };

/**
 * The payload URL's choice for one request (RFC 9842 §2–§4): dcz when the request offers a
 * dictionary that is the `from` of one of the payload's deltas and accepts `dcz`; else, under
 * the guard, `409`; else the full payload, which a zstd `full` can only be sent as with `zstd` in
 * `Accept-Encoding` (the stored frame is never decoded at the edge).
 */
export function choosePayloadAnswer(r: {
  acceptEncoding: string | null;
  availableDictionary: string | null;
  guard: boolean;
  fullCodec: string;
  /** The deltas TO this payload whose artifact this request may be served. */
  deltas: readonly {
    from: string;
    artifact: { sha256: string; bytes: number };
  }[];
}): PayloadAnswer {
  const offered = parseAvailableDictionary(r.availableDictionary);
  if (offered !== null && acceptsEncoding(r.acceptEncoding, "dcz")) {
    const d = r.deltas.find((x) => x.from === offered);
    if (d) return { kind: "dcz", from: d.from, artifact: d.artifact };
  }
  if (r.guard) return { kind: "refuse", status: 409 };
  if (r.fullCodec === "none") return { kind: "full", encoding: null };
  if (r.fullCodec === "zstd" && acceptsEncoding(r.acceptEncoding, "zstd"))
    return { kind: "full", encoding: "zstd" };
  return { kind: "refuse", status: 406 };
}
