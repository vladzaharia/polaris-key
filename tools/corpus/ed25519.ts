// Ed25519 constructions (V4 §1.1) on @noble/curves, for the hand-signed `jwsCases` only, never a
// verifier; `checkEd25519Tables` holds the reference's small-order table to the curve.

import { createHash } from "node:crypto";
import { base64UrlDecode, base64UrlEncodeBytes } from "@polaris-key/jws";
import { ED25519_TORSION_SUBGROUP, ed25519 } from "@noble/curves/ed25519.js";
import { headerText, pem, PIN_KID, pub, utf8Bytes } from "./common.js";
import {
  bigToLe,
  bytesHex,
  ED_L,
  ED_P,
  IDENTITY_Y_P_PLUS_1,
  leToBig,
  SMALL_ORDER_REF,
} from "./reference/ed25519.js";

export const EdPoint = ed25519.Point;
function sha512(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha512");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/** The secret scalar of a committed PKCS#8 key: SHA-512 of the seed, clamped (RFC 8032). */
export function secretScalar(kid: string): bigint {
  const der = Buffer.from(
    pem(kid)
      .replace(/-----[^-]+-----/g, "")
      .replace(/\s+/g, ""),
    "base64",
  );
  const h = sha512(new Uint8Array(der.subarray(der.length - 32)));
  h[0]! &= 248;
  h[31]! &= 127;
  h[31]! |= 64;
  return leToBig(h.subarray(0, 32));
}

/** A deterministic nonce for the hand-built signatures: SHA-512 of a label, mod L. */
export const nonce = (label: string, counter: number): bigint =>
  leToBig(sha512(utf8Bytes(`pkey-corpus-v4-r:${label}:${counter}`))) % ED_L;

/** `k = H(R ‖ A ‖ M) mod L` over the ASCII signing input. */
const challenge = (rEnc: Uint8Array, aEnc: Uint8Array, input: string): bigint =>
  leToBig(sha512(rEnc, aEnc, utf8Bytes(input))) % ED_L;

/** Assemble a compact JWS from text segments and a hand-built `R ‖ S`. */
function assembleJws(
  header: string,
  payload: string,
  rEnc: Uint8Array,
  s: bigint,
): string {
  const input = `${base64UrlEncodeBytes(utf8Bytes(header))}.${base64UrlEncodeBytes(utf8Bytes(payload))}`;
  const sig = new Uint8Array(64);
  sig.set(rEnc, 0);
  sig.set(bigToLe(s, 32), 32);
  return `${input}.${base64UrlEncodeBytes(sig)}`;
}

/** Sign `payload` as `kid` (header) with the hand-held scalar `a` of key `aEnc`, using `rEnc`
 *  (and its scalar `r`, or 0 for a non-point / identity `R`). Optionally grind the nonce until
 *  `k mod 8` satisfies `want` — the order-8 and mixed-order constructions. */
export function handSign(opts: {
  kid: string;
  payload: string;
  aEnc: Uint8Array;
  a: bigint;
  label: string;
  rEnc?: Uint8Array;
  kMod8?: "zero" | "nonzero";
}): { jws: string; k: bigint; s: bigint } {
  const header = headerText("pkey-license+jws", opts.kid);
  const input = (): string =>
    `${base64UrlEncodeBytes(utf8Bytes(header))}.${base64UrlEncodeBytes(utf8Bytes(opts.payload))}`;
  for (let counter = 0; counter < 512; counter++) {
    let r = 0n;
    let rEnc = opts.rEnc;
    if (!rEnc) {
      r = nonce(opts.label, counter);
      rEnc = EdPoint.BASE.multiply(r).toBytes();
    }
    const k = challenge(rEnc, opts.aEnc, input());
    if (opts.kMod8 === "zero" && k % 8n !== 0n) continue;
    if (opts.kMod8 === "nonzero" && k % 8n === 0n) continue;
    const s = (r + k * opts.a) % ED_L;
    return { jws: assembleJws(header, opts.payload, rEnc, s), k, s };
  }
  throw new Error(`handSign: could not grind ${opts.label}`);
}

/** Self-checks of the constructions (plans/P3-01.md §4.9). */
export function checkEd25519Tables(): void {
  const fail = (m: string): never => {
    throw new Error(`ed25519: ${m}`);
  };
  const torsion = new Set(ED25519_TORSION_SUBGROUP);
  if (torsion.size !== 8 || !SMALL_ORDER_REF.every((h) => torsion.has(h)))
    fail("the small-order table differs from noble's torsion subgroup");
  for (const h of SMALL_ORDER_REF)
    if (!EdPoint.fromHex(h).isSmallOrder()) fail(`${h} is not small order`);
  const t8 = EdPoint.fromHex(SMALL_ORDER_REF[6]!);
  if (t8.multiplyUnsafe(4n).equals(EdPoint.ZERO))
    fail("the order-8 point has order 4");
  if (!t8.multiplyUnsafe(8n).equals(EdPoint.ZERO))
    fail("the order-8 point is not order 8");
  if (leToBig(IDENTITY_Y_P_PLUS_1) !== ED_P + 1n) fail("y = p + 1 encoding");
  const pinA = base64UrlDecode(pub(PIN_KID));
  if (
    bytesHex(EdPoint.BASE.multiply(secretScalar(PIN_KID) % ED_L).toBytes()) !==
    bytesHex(pinA)
  )
    fail("the PIN key's scalar does not reproduce its public key");
}
