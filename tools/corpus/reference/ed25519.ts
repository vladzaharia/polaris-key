// Reference: the Ed25519 field constants and the small-order point table the verifier refuses.
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

// ── Ed25519 constructions (V4 §1.1), on @noble/curves — vectors only, never a verifier ────────

export const ED_L = 2n ** 252n + 27742317777372353535851937790883648493n;
export const ED_P = 2n ** 255n - 19n;

export function leToBig(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let k = bytes.length - 1; k >= 0; k--) n = (n << 8n) | BigInt(bytes[k]!);
  return n;
}
export function bigToLe(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let k = 0; k < length; k++, n >>= 8n) out[k] = Number(n & 0xffn);
  return out;
}
const hexBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
export const bytesHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The small-order encodings, restated (V4 §1.1 check 3). */
export const SMALL_ORDER_REF = [
  "0100000000000000000000000000000000000000000000000000000000000000",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
];
export const IDENTITY_ENC = hexBytes(SMALL_ORDER_REF[0]!);
/** The identity with y = p + 1, a non-canonical encoding (check 2). */
export const IDENTITY_Y_P_PLUS_1 = bigToLe(ED_P + 1n, 32);
/** x = 0 with the sign bit set: `01 00…00 80` (check 2). */
export const NEGATIVE_ZERO_ENC = hexBytes(
  "0100000000000000000000000000000000000000000000000000000000000080",
);
export const ORDER8_ENC = hexBytes(SMALL_ORDER_REF[6]!);
