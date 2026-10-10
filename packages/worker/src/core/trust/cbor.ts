/**
 * A minimal, strict CBOR decoder (RFC 8949) for the one CBOR document the Worker reads: an Apple
 * App Attest attestation object (P6-02, `core/trust/appAttest.ts`).
 *
 * Scope is deliberately narrow, because the input is attacker-supplied:
 *
 *   - definite lengths only (an indefinite-length item, additional info 31, is refused);
 *   - unsigned and negative integers up to 2^53 - 1 (larger is refused, never rounded);
 *   - byte strings, UTF-8 text strings (decoded fatally: a bad sequence is an error), arrays,
 *     maps (returned as a `Map`, so a key is never coerced into a property name), tags (the tag
 *     number is dropped and the tagged item returned), and the simple values false, true, null
 *     and undefined;
 *   - floats and other simple values are refused (App Attest has none);
 *   - nesting is capped at `MAX_DEPTH`, the item count at `MAX_ITEMS`, and the whole input must be
 *     exactly one item: trailing bytes are an error.
 *
 * Pure (no I/O, no globals beyond `TextDecoder`), so it runs identically in Node and workerd.
 */

export type CborValue =
  | number
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | Map<CborValue, CborValue>;

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

const MAX_DEPTH = 16;
const MAX_ITEMS = 10_000;

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface Cursor {
  buf: Uint8Array;
  pos: number;
  items: number;
}

function need(c: Cursor, n: number): void {
  if (n < 0 || c.pos + n > c.buf.length) throw new CborError("truncated");
}

/** The argument of an item head: the length, the integer value or the tag number. */
function readArgument(c: Cursor, info: number): number {
  if (info < 24) return info;
  if (info === 24) {
    need(c, 1);
    return c.buf[c.pos++]!;
  }
  if (info === 25) {
    need(c, 2);
    const v = (c.buf[c.pos]! << 8) | c.buf[c.pos + 1]!;
    c.pos += 2;
    return v;
  }
  if (info === 26) {
    need(c, 4);
    const v =
      c.buf[c.pos]! * 0x1000000 +
      ((c.buf[c.pos + 1]! << 16) |
        (c.buf[c.pos + 2]! << 8) |
        c.buf[c.pos + 3]!);
    c.pos += 4;
    return v;
  }
  if (info === 27) {
    need(c, 8);
    const hi =
      c.buf[c.pos]! * 0x1000000 +
      ((c.buf[c.pos + 1]! << 16) |
        (c.buf[c.pos + 2]! << 8) |
        c.buf[c.pos + 3]!);
    const lo =
      c.buf[c.pos + 4]! * 0x1000000 +
      ((c.buf[c.pos + 5]! << 16) |
        (c.buf[c.pos + 6]! << 8) |
        c.buf[c.pos + 7]!);
    c.pos += 8;
    // 2^53 - 1 is the largest integer a number holds exactly: hi may use 21 bits.
    if (hi > 0x1fffff) throw new CborError("integer too large");
    return hi * 0x100000000 + lo;
  }
  if (info === 31) throw new CborError("indefinite length not supported");
  throw new CborError("reserved additional information");
}

function readItem(c: Cursor, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new CborError("nesting too deep");
  if (++c.items > MAX_ITEMS) throw new CborError("too many items");
  need(c, 1);
  const head = c.buf[c.pos++]!;
  const major = head >> 5;
  const info = head & 0x1f;
  switch (major) {
    case 0:
      return readArgument(c, info);
    case 1:
      return -1 - readArgument(c, info);
    case 2: {
      const len = readArgument(c, info);
      need(c, len);
      const out = c.buf.slice(c.pos, c.pos + len);
      c.pos += len;
      return out;
    }
    case 3: {
      const len = readArgument(c, info);
      need(c, len);
      let s: string;
      try {
        s = UTF8.decode(c.buf.subarray(c.pos, c.pos + len));
      } catch {
        throw new CborError("invalid UTF-8 text");
      }
      c.pos += len;
      return s;
    }
    case 4: {
      const len = readArgument(c, info);
      // Every item takes at least one byte: a length beyond the remaining input is a lie.
      need(c, len);
      const out: CborValue[] = [];
      for (let i = 0; i < len; i++) out.push(readItem(c, depth + 1));
      return out;
    }
    case 5: {
      const len = readArgument(c, info);
      need(c, len * 2);
      const out = new Map<CborValue, CborValue>();
      for (let i = 0; i < len; i++) {
        const k = readItem(c, depth + 1);
        if (typeof k !== "string" && typeof k !== "number")
          throw new CborError("map keys must be text or integers");
        if (out.has(k)) throw new CborError("duplicate map key");
        out.set(k, readItem(c, depth + 1));
      }
      return out;
    }
    case 6:
      readArgument(c, info);
      return readItem(c, depth + 1);
    default:
      // major 7
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      throw new CborError("unsupported simple value or float");
  }
}

/** Decode exactly one CBOR item spanning all of `bytes`. Throws `CborError` on anything else. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const c: Cursor = { buf: bytes, pos: 0, items: 0 };
  const v = readItem(c, 0);
  if (c.pos !== bytes.length) throw new CborError("trailing bytes");
  return v;
}
