// Frames for the zstd-wasm tests. The two `zstd` frames were produced once with the zstd CLI
// 1.5.7 (`zstd -19 text.bin`, `zstd --patch-from=base.bin tgt.bin`); the window frame is
// assembled by hand from RFC 8878 §3.1.1.

const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

/** "pkey-files/1 " × 200 (2,600 bytes), one frame at level 19. */
export const TEXT = new TextEncoder().encode("pkey-files/1 ".repeat(200));
export const TEXT_FRAME = b64(
  "KLUv/WQoCa0AAGhwa2V5LWZpbGVzLzEgAQAYAn9+Ab+MDaI=",
);

/** A deterministic 20,000-byte base (lowercase letters from an LCG). */
export function base(): Uint8Array {
  const out = new Uint8Array(20000);
  let s = 1;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = 97 + ((s >> 16) % 26);
  }
  return out;
}

/** The target: the base with "POLARIS-KEY-PATCH" at 5,000 and digits at 12,000–12,099. */
export function target(): Uint8Array {
  const out = base();
  out.set(new TextEncoder().encode("POLARIS-KEY-PATCH"), 5000);
  for (let i = 12000; i < 12100; i++) out[i] = 48 + (i % 10);
  return out;
}

/** `zstd --patch-from=base target`: single-segment, so its window is its content size, 20,000
 *  (a 2-byte Frame_Content_Size, 0x4d20 + 256). ⌈log2(20,000)⌉ = 15. */
export const PATCH_FRAME = b64(
  "KLUv/WQgTXUBANhQT0xBUklTLUtFWS1QQVRDSDAxMjM0NTY3ODkEANkOenAtE0q0oN/CGXF6BgSTXXuc",
);

/**
 * A hand-assembled frame declaring a 2^23 window: descriptor 0x80 (a 4-byte content size, not
 * single-segment, no checksum, no dictionary), Window_Descriptor 0x68 (exponent 13, mantissa 0:
 * 2^(10+13)), content size 5, and one last raw block "hello". libzstd's one-shot decode accepts
 * it at any limit; the header check refuses it at windowLogMax 22.
 */
export const WINDOW_23_FRAME = new Uint8Array([
  0x28, 0xb5, 0x2f, 0xfd, 0x80, 0x68, 0x05, 0x00, 0x00, 0x00, 0x29, 0x00, 0x00,
  0x68, 0x65, 0x6c, 0x6c, 0x6f,
]);
