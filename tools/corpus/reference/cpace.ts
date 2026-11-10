// Reference: CPace for account-free local pairing (WIRE-CONTRACT-V5 §15.12, "The mode-q handshake").
//
// Suite CPACE-X25519-SHA512 of draft-irtf-cfrg-cpace-21 in its initiator-responder setting: the
// string functions (`prepend_len`, `lv_cat`, `generator_string`, `transcript_ir`), `decodeUCoordinate`,
// the Elligator 2 map, the share check, the ISK, and the two frames C1 and C2 that run before
// Noise. Written from the draft's text over `node:crypto` (SHA-512, HKDF, X25519 through the Noise
// reference's helpers) and a BigInt Elligator 2 of its own; it shares nothing with client-core. The
// draft's own vectors (`inputs/cpace-anchors.json`) are checked against it by `noise.ts`.

import { createHash } from "node:crypto";
import { bytesHex, hexBytes, refHkdf, refX25519 } from "./noise.js";
import { cat, utf8 } from "./peerMatrix.js";
import { REF_X25519_LOW_ORDER_HEX } from "./peer.js";

export { bytesHex, hexBytes };

/** The prime field of Curve25519, 2^255 − 19. */
export const REF_P = (1n << 255n) - 19n;
/** The Montgomery coefficient A of Curve25519 (B = 1). */
const A = 486662n;
/** The non-square the draft's `find_z_ell2` finds for Curve25519. */
const Z = 2n;

export const REF_CPACE_DSI = "CPace255";
export const REF_CPACE_DSI_ISK = "CPace255_ISK";
/** SHA-512's input block size. */
export const REF_CPACE_S_IN_BYTES = 128;

const sha512 = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const p of parts) h.update(p);
  return Uint8Array.from(h.digest());
};

// ── The draft's string functions (appendix A) ────────────────────────────────

/** A.1.1: the LEB128 length, then the data. */
export function refPrependLen(data: Uint8Array): Uint8Array {
  const len: number[] = [];
  let n = data.length;
  for (;;) {
    if (n < 128) len.push(n);
    else len.push((n & 0x7f) + 0x80);
    n = Math.floor(n / 128);
    if (n === 0) break;
  }
  return cat(Uint8Array.from(len), data);
}

/** A.1.3 */
export const refLvCat = (...args: Uint8Array[]): Uint8Array =>
  cat(...args.map(refPrependLen));

/** A.2 */
export function refGeneratorString(
  dsi: Uint8Array,
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
  sInBytes: number,
): Uint8Array {
  const zpad = Math.max(
    0,
    sInBytes - 1 - refPrependLen(prs).length - refPrependLen(dsi).length,
  );
  return refLvCat(dsi, prs, new Uint8Array(zpad), ci, sid);
}

/** A.3.4 */
export const refTranscriptIr = (
  ya: Uint8Array,
  ada: Uint8Array,
  yb: Uint8Array,
  adb: Uint8Array,
): Uint8Array => cat(refLvCat(ya, ada), refLvCat(yb, adb));

function lexLarger(a: Uint8Array, b: Uint8Array): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return a.length > b.length;
}

/** A.3.2 */
export const refOCat = (a: Uint8Array, b: Uint8Array): Uint8Array =>
  lexLarger(a, b) ? cat(utf8("oc"), a, b) : cat(utf8("oc"), b, a);

/** A.3.6 (the parallel setting; the pairing does not use it, the draft's vectors do). */
export const refTranscriptOc = (
  ya: Uint8Array,
  ada: Uint8Array,
  yb: Uint8Array,
  adb: Uint8Array,
): Uint8Array => refOCat(refLvCat(ya, ada), refLvCat(yb, adb));

// ── The field, decodeUCoordinate and the Elligator 2 map ─────────────────────

const mod = (a: bigint): bigint => ((a % REF_P) + REF_P) % REF_P;

function pow(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % REF_P;
    b = (b * b) % REF_P;
    e >>= 1n;
  }
  return r;
}

const inv = (a: bigint): bigint => pow(a, REF_P - 2n);

/** RFC 7748 `decodeUCoordinate(u, 255)`: 32 little-endian bytes with bit 255 cleared. Not reduced. */
export function refDecodeU(u: Uint8Array): bigint {
  let n = 0n;
  for (let i = 31; i >= 0; i--)
    n = (n << 8n) | BigInt(i === 31 ? u[i]! & 0x7f : u[i]!);
  return n;
}

/** `encodeUCoordinate`: 32 little-endian bytes of a canonical field element. */
export function refEncodeU(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = x;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 255n);
    v >>= 8n;
  }
  return out;
}

export interface RefElligator {
  /** The field element after reduction: `decodeUCoordinate(input) mod p`. */
  r: Uint8Array;
  /** Whether the candidate `v = −A / (1 + 2 r²)` is on the curve (ε = 1) or on the twist (ε = −1). */
  onCurve: boolean;
  /** The u-coordinate of the result. */
  u: Uint8Array;
}

/** The draft's `elligator2` (appendix A.5) for Curve25519 with Z = 2. `input` is 32 bytes. */
export function refElligator2(input: Uint8Array): RefElligator {
  const r = mod(refDecodeU(input));
  // 1 + 2 r² is never 0: −1/2 is a non-square mod p (p ≡ 5 mod 8), so no r solves it.
  const v = mod(-A * inv(1n + Z * r * r));
  const gv = mod(v * v * v + A * v * v + v);
  const eps = pow(gv, (REF_P - 1n) / 2n);
  // eps is 1 or p − 1 (gv is never 0: A² − 4 is a non-square, so v² + A v + 1 has no root).
  const onCurve = eps === 1n;
  if (!onCurve && eps !== REF_P - 1n)
    throw new Error("cpace: Elligator 2 gave a zero g(v)");
  const x = onCurve ? v : mod(-v - A);
  return { r: refEncodeU(r), onCurve, u: refEncodeU(x) };
}

// ── The generator (§8.2) ─────────────────────────────────────────────────────

export interface RefGenerator {
  generatorString: Uint8Array;
  /** The first 32 bytes of SHA-512 of the generator string. */
  hash: Uint8Array;
  /** `decodeUCoordinate(hash, 255)` as 32 bytes (bit 255 cleared, not reduced). */
  decoded: Uint8Array;
  /** The generator's u-coordinate, 32 bytes little-endian. */
  g: Uint8Array;
}

export function refCpaceGenerator(
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
  ad = {
    dsi: utf8(REF_CPACE_DSI),
    sInBytes: REF_CPACE_S_IN_BYTES,
  },
): RefGenerator {
  const generatorString = refGeneratorString(ad.dsi, prs, ci, sid, ad.sInBytes);
  const hash = sha512(generatorString).slice(0, 32);
  const decoded = Uint8Array.from(hash);
  decoded[31] = decoded[31]! & 0x7f;
  return { generatorString, hash, decoded, g: refElligator2(hash).u };
}

// ── The password-related string (§15.12) ─────────────────────────────────────

/** `"pkey-peer/1 code" ‖ 0x00 ‖ <the 6 ASCII password digits>`. */
export const refPrsCode = (digits: string): Uint8Array => {
  if (!/^[0-9]{6}$/.test(digits)) throw new Error(`cpace: password ${digits}`);
  return cat(utf8("pkey-peer/1 code"), Uint8Array.of(0), utf8(digits));
};

/** `"pkey-peer/1 qr" ‖ 0x00 ‖ <the 16 secret bytes>`. */
export const refPrsQr = (secret: Uint8Array): Uint8Array => {
  if (secret.length !== 16) throw new Error("cpace: QR secret length");
  return cat(utf8("pkey-peer/1 qr"), Uint8Array.of(0), secret);
};

export type CpaceKind = "code" | "qr";
export const REF_KIND_BYTE: Record<CpaceKind, number> = { code: 1, qr: 2 };

// ── Shares and the refusals (§15.12 step 3) ──────────────────────────────────

export type ShareVerdict =
  | { ok: true }
  | { ok: false; reason: "length" | "non-canonical" | "low-order" };

/** A share is 32 bytes, canonical (bit 255 clear and u < p) and not one of the low-order points. */
export function refShareCheck(y: Uint8Array): ShareVerdict {
  if (y.length !== 32) return { ok: false, reason: "length" };
  if ((y[31]! & 0x80) !== 0 || refDecodeU(y) >= REF_P)
    return { ok: false, reason: "non-canonical" };
  const hex = bytesHex(y) as (typeof REF_X25519_LOW_ORDER_HEX)[number];
  if (REF_X25519_LOW_ORDER_HEX.includes(hex))
    return { ok: false, reason: "low-order" };
  return { ok: true };
}

export const refShare = (y: Uint8Array, g: Uint8Array): Uint8Array =>
  refX25519(y, g);

export const refIsZero32 = (b: Uint8Array): boolean => b.every((x) => x === 0);

// ── ISK and the Noise PSK (§15.12) ───────────────────────────────────────────

/** `SHA-512(lv_cat("CPace255_ISK", sid, K) ‖ transcript_ir(Ya, ADa, Yb, ADb))`, 64 bytes. */
export const refIsk = (
  sid: Uint8Array,
  k: Uint8Array,
  ya: Uint8Array,
  yb: Uint8Array,
  ada: Uint8Array = new Uint8Array(0),
  adb: Uint8Array = new Uint8Array(0),
): Uint8Array =>
  sha512(
    refLvCat(utf8(REF_CPACE_DSI_ISK), sid, k),
    refTranscriptIr(ya, ada, yb, adb),
  );

/** The parallel-execution ISK of the draft (anchor only). */
export const refIskOc = (
  sid: Uint8Array,
  k: Uint8Array,
  ya: Uint8Array,
  yb: Uint8Array,
  ada: Uint8Array,
  adb: Uint8Array,
): Uint8Array =>
  sha512(
    refLvCat(utf8(REF_CPACE_DSI_ISK), sid, k),
    refTranscriptOc(ya, ada, yb, adb),
  );

/** `HKDF-SHA256(salt = empty, ikm = ISK, info = "pkey-peer/1 cpace" ‖ 0x00 ‖ slug)`, 32 bytes. */
export const refCpacePsk = (isk: Uint8Array, slug: string): Uint8Array =>
  refHkdf(
    new Uint8Array(0),
    isk,
    cat(utf8("pkey-peer/1 cpace"), Uint8Array.of(0), utf8(slug)),
    32,
  );

// ── The frames C1 and C2 (§15.12 step 2) ─────────────────────────────────────

/** C1, joiner to shower: `0x01 ‖ kind ‖ Ya`, 34 bytes. */
export const refC1 = (kind: CpaceKind, ya: Uint8Array): Uint8Array =>
  cat(Uint8Array.of(1, REF_KIND_BYTE[kind]), ya);

/** C2, shower to joiner: `0x01 ‖ Yb`, 33 bytes. */
export const refC2 = (yb: Uint8Array): Uint8Array => cat(Uint8Array.of(1), yb);

export type FrameVerdict =
  | { ok: true; kind?: CpaceKind; share: Uint8Array }
  | {
      ok: false;
      reason: "length" | "version" | "kind" | "non-canonical" | "low-order";
    };

export function refParseC1(b: Uint8Array): FrameVerdict {
  if (b.length !== 34) return { ok: false, reason: "length" };
  if (b[0] !== 1) return { ok: false, reason: "version" };
  const kind = b[1] === 1 ? "code" : b[1] === 2 ? "qr" : null;
  if (kind === null) return { ok: false, reason: "kind" };
  const share = b.slice(2);
  const v = refShareCheck(share);
  if (!v.ok)
    return { ok: false, reason: v.reason as "non-canonical" | "low-order" };
  return { ok: true, kind, share };
}

export function refParseC2(b: Uint8Array): FrameVerdict {
  if (b.length !== 33) return { ok: false, reason: "length" };
  if (b[0] !== 1) return { ok: false, reason: "version" };
  const share = b.slice(1);
  const v = refShareCheck(share);
  if (!v.ok)
    return { ok: false, reason: v.reason as "non-canonical" | "low-order" };
  return { ok: true, share };
}

// ── One attempt, end to end ──────────────────────────────────────────────────

export interface RefCpaceIn {
  kind: CpaceKind;
  /** The 6 password digits (kind code) or the 16 QR secret bytes as hex (kind qr). */
  secret: string;
  slug: string;
  /** The mode-q prologue. */
  ci: Uint8Array;
  /** The window's 10 bytes. */
  sid: Uint8Array;
  /** The joiner's and the shower's 32-byte scalars. */
  ya: Uint8Array;
  yb: Uint8Array;
}

export interface RefCpaceOut {
  prs: Uint8Array;
  gen: RefGenerator;
  Ya: Uint8Array;
  Yb: Uint8Array;
  c1: Uint8Array;
  c2: Uint8Array;
  /** K as each side computes it; equal on an honest run. */
  kJoiner: Uint8Array;
  kShower: Uint8Array;
  isk: Uint8Array;
  psk: Uint8Array;
}

export const refPrs = (kind: CpaceKind, secret: string): Uint8Array =>
  kind === "code" ? refPrsCode(secret) : refPrsQr(hexBytes(secret));

export function refCpaceRun(i: RefCpaceIn): RefCpaceOut {
  const prs = refPrs(i.kind, i.secret);
  const gen = refCpaceGenerator(prs, i.ci, i.sid);
  const Ya = refShare(i.ya, gen.g);
  const Yb = refShare(i.yb, gen.g);
  const kJoiner = refX25519(i.ya, Yb);
  const kShower = refX25519(i.yb, Ya);
  const isk = refIsk(i.sid, kJoiner, Ya, Yb);
  return {
    prs,
    gen,
    Ya,
    Yb,
    c1: refC1(i.kind, Ya),
    c2: refC2(Yb),
    kJoiner,
    kShower,
    isk,
    psk: refCpacePsk(isk, i.slug),
  };
}
