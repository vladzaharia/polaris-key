// The zstd window check (plans/P4-01.md §2.7 rule 3; WIRE-CONTRACT-V4 §2.6): one rule for every
// SDK and for `decodeWithPrefix`. Before an applier decodes a `zstd-patch-from` frame it reads
// the frame's window from the header bytes alone (`frameWindow`) and refuses the frame as
// `delta-apply-failed` when that is null or above 2^`windowLogMax(memBytes)`. No decoder
// parameter replaces the check: libzstd enforces its own window limit only when it streams
// through a small buffer. `content/cases.json#frameWindowCases` pins `frameWindow`.

/** 2^32: the saturation point of `frameWindow`, above every `windowLogMax`. */
const WINDOW_CEILING = 2 ** 32;

/**
 * `frameWindow(bytes)` (plans/P4-01.md §2.7): the window of the zstd frame whose header starts
 * `bytes`, read per RFC 8878 §3.1.1. Null unless bytes 0–3 are `28 B5 2F FD`, the reserved bit
 * (`0x08`) of the descriptor at byte 4 is clear, and `bytes` hold the whole header. With
 * Single_Segment_flag (`0x20`) the window is Frame_Content_Size (little-endian, plus 256 for a
 * 2-byte field); otherwise it comes from the Window_Descriptor `w`:
 * `b + (b >> 3) × (w & 7)` with `b = 2^(10 + (w >> 3))`. A window of 2^32 or more is 2^32.
 * Never throws; needs no integer above 2^53.
 */
export function frameWindow(bytes: Uint8Array): number | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5) return null;
  if (
    bytes[0] !== 0x28 ||
    bytes[1] !== 0xb5 ||
    bytes[2] !== 0x2f ||
    bytes[3] !== 0xfd
  )
    return null;
  const d = bytes[4]!;
  if ((d & 0x08) !== 0) return null;
  const single = (d & 0x20) !== 0;
  const dictBytes = [0, 1, 2, 4][d & 0x03]!;
  const fcsFlag = d >> 6;
  const fcsBytes = fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag]!;
  const headerBytes = 5 + (single ? 0 : 1) + dictBytes + fcsBytes;
  if (bytes.byteLength < headerBytes) return null;
  if (!single) {
    const w = bytes[5]!;
    const b = 2 ** (10 + (w >> 3));
    return Math.min(b + (b / 8) * (w & 7), WINDOW_CEILING);
  }
  // Single segment: the window is the content size. Read it little-endian, saturating at 2^32
  // so an 8-byte field never needs more than a double holds exactly.
  const at = 5 + dictBytes;
  if (fcsBytes === 8) {
    for (let i = 4; i < 8; i++) if (bytes[at + i] !== 0) return WINDOW_CEILING;
  }
  let v = 0;
  for (let i = Math.min(fcsBytes, 4) - 1; i >= 0; i--)
    v = v * 256 + bytes[at + i]!;
  if (fcsBytes === 2) v += 256;
  return Math.min(v, WINDOW_CEILING);
}

/**
 * `windowLogMax = max(10, min(P, ⌈log2(memBytes)⌉))` (plans/P4-01.md §2.7 rule 3), in integers:
 * ⌈log2(m)⌉ is the bit length of m − 1 (never a floating `log`, which rounds 2^29 and 2^31 up).
 * `p` is 31 for a 64-bit decoder (the default) and 30 for a 32-bit or wasm32 one. Returns null
 * when `memBytes` is not a non-negative safe integer or `p` is not 30 or 31.
 */
export function windowLogMax(memBytes: number, p = 31): number | null {
  if (!Number.isSafeInteger(memBytes) || memBytes < 0) return null;
  if (p !== 30 && p !== 31) return null;
  let n = 0;
  // Halve rather than shift: memBytes may exceed 2^31, where `>>` would wrap.
  for (let v = memBytes - 1; v > 0; v = Math.floor(v / 2)) n++;
  return Math.max(10, Math.min(p, n));
}

/**
 * The window check itself: true when `frame`'s header window is known and at most
 * 2^`windowLogMax(memBytes, p)`. An applier refuses the frame as `delta-apply-failed` otherwise,
 * before it decodes a byte.
 */
export function windowAllowed(
  frame: Uint8Array,
  memBytes: number,
  p = 31,
): boolean {
  const limit = windowLogMax(memBytes, p);
  const window = frameWindow(frame);
  return limit !== null && window !== null && window <= 2 ** limit;
}
