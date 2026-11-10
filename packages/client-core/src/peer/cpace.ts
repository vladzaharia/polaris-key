// WIRE-CONTRACT-V5 §15.12, "The mode-q handshake": CPace for account-free local pairing. Suite
// CPACE-X25519-SHA512 of draft-irtf-cfrg-cpace-21 in its initiator-responder setting, written from
// the draft's text: the string functions (`prepend_len`, `lv_cat`, `generator_string`,
// `transcript_ir`), `decodeUCoordinate`, the Elligator 2 map, the share check, the ISK, the PSK that
// feeds Noise, and the two frames (C1, C2) that run before it. Nothing here does I/O.
//
// Timing. Every scalar multiplication runs through the `X25519Port`, which is the platform's
// constant-time X25519 (WebCrypto by default). The Elligator 2 map does not: it runs over `BigInt`,
// whose arithmetic is variable-time, and its input is derived from the password. That is acceptable
// only because of §15.12 step 6: the shower computes its generators at every rotation, and the joiner
// computes its own before it dials, so the map never runs between a network event and its answer and
// its timing is not observable by a peer. Callers MUST compute `cpaceGenerator` ahead of the
// connection and keep it, never inside a request handler's latency path. The external cryptographer
// confirms this (packet part P5).
//
// A share or a K that breaks a rule is a refusal, not an exception: the caller closes the connection
// silently and counts no failure (§15.12 step 3).

import { isX25519LowOrder } from "@polaris-key/jws";
import { cat, utf8 } from "./advert.js";
import { hkdfSha256, webCryptoX25519, type X25519Port } from "./noise.js";

export type CpaceKind = "code" | "qr";

/** The first byte of both frames. */
export const CPACE_FRAME_VERSION = 0x01;
/** The kind byte of C1: `0x01` for a code, `0x02` for a QR. */
export const CPACE_KIND_BYTE: Readonly<Record<CpaceKind, number>> = {
  code: 0x01,
  qr: 0x02,
};
export const CPACE_C1_LENGTH = 34;
export const CPACE_C2_LENGTH = 33;
export const CPACE_SHARE_LENGTH = 32;
/** The QR secret, in bytes (`LOCAL_QR_SECRET_BYTES`). */
export const CPACE_QR_SECRET_BYTES = 16;

const DSI = "CPace255";
const DSI_ISK = "CPace255_ISK";
/** SHA-512's input block size, the draft's `s_in_bytes`. */
const S_IN_BYTES = 128;

const buf = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

async function sha512(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-512", buf(cat(...parts))),
  );
}

// ── The draft's string functions (appendix A) ────────────────────────────────

/** `prepend_len`: the LEB128 length, then the data. */
export function prependLen(data: Uint8Array): Uint8Array {
  const len: number[] = [];
  let rest = data.length;
  while (rest >= 128) {
    len.push((rest % 128) + 128);
    rest = Math.floor(rest / 128);
  }
  len.push(rest);
  return cat(Uint8Array.from(len), data);
}

/** `lv_cat`: every argument length-prefixed, then concatenated. */
export const lvCat = (...args: Uint8Array[]): Uint8Array =>
  cat(...args.map(prependLen));

/** `generator_string(DSI, PRS, CI, sid, s_in_bytes)`. */
export function generatorString(
  dsi: Uint8Array,
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
  sInBytes: number,
): Uint8Array {
  const zpad = Math.max(
    0,
    sInBytes - 1 - prependLen(prs).length - prependLen(dsi).length,
  );
  return lvCat(dsi, prs, new Uint8Array(zpad), ci, sid);
}

/** `transcript_ir(Ya, ADa, Yb, ADb)`. */
export const transcriptIr = (
  ya: Uint8Array,
  ada: Uint8Array,
  yb: Uint8Array,
  adb: Uint8Array,
): Uint8Array => cat(lvCat(ya, ada), lvCat(yb, adb));

// ── The field, decodeUCoordinate and the Elligator 2 map ─────────────────────

/** The prime of Curve25519, 2^255 − 19. */
const P = (1n << 255n) - 19n;
/** The Montgomery coefficient A of Curve25519 (B = 1). */
const A = 486662n;
/** The non-square the draft's `find_z_ell2` finds for Curve25519. */
const Z = 2n;

const mod = (a: bigint): bigint => ((a % P) + P) % P;

function pow(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = mod(base);
  for (let e = exp; e > 0n; e >>= 1n) {
    if ((e & 1n) === 1n) r = (r * b) % P;
    b = (b * b) % P;
  }
  return r;
}

/** The little-endian integer of `b`. */
const fromLittleEndian = (b: Uint8Array): bigint =>
  BigInt(
    "0x" +
      Array.from(b, (x) => x.toString(16).padStart(2, "0"))
        .reverse()
        .join(""),
  );

/** `decodeUCoordinate(u, 255)`: bit 255 cleared, the rest read little-endian; not reduced. */
function decodeU(u: Uint8Array): bigint {
  const masked = Uint8Array.from(u);
  masked[31] = masked[31]! & 0x7f;
  return fromLittleEndian(masked);
}

/** 32 little-endian bytes of a field element in `[0, p)`. */
function encodeU(x: bigint): Uint8Array {
  const hex = x.toString(16).padStart(64, "0");
  return Uint8Array.from(hex.match(/../g)!.reverse(), (h) => parseInt(h, 16));
}

export interface Elligator2Result {
  /** `decodeUCoordinate(input) mod p`, 32 bytes. */
  r: Uint8Array;
  /** Whether `v = −A / (1 + 2 r²)` is on the curve; otherwise the result comes from the twist. */
  onCurve: boolean;
  /** The u-coordinate of the result, 32 bytes little-endian. */
  u: Uint8Array;
}

/**
 * The draft's `map_to_curve_elligator2` for Curve25519 (Z = 2) on 32 input bytes. It is variable
 * time (see the file header): run it ahead of the connection, never on the network path.
 */
export function elligator2(input: Uint8Array): Elligator2Result {
  if (input.length !== 32) throw new RangeError("elligator2: 32 bytes");
  const r = mod(decodeU(input));
  // 1 + 2 r² is never 0: −1/2 is a non-square mod p, since p ≡ 5 (mod 8).
  const v = mod(-A * pow(1n + Z * r * r, P - 2n));
  const gv = mod(v * v * v + A * v * v + v);
  const eps = pow(gv, (P - 1n) / 2n);
  // g(v) is never 0 (A² − 4 is a non-square), so ε is 1 or p − 1.
  if (eps !== 1n && eps !== P - 1n)
    throw new RangeError("elligator2: g(v) is zero");
  const onCurve = eps === 1n;
  return {
    r: encodeU(r),
    onCurve,
    u: encodeU(onCurve ? v : mod(-v - A)),
  };
}

// ── The password-related string and the generator ────────────────────────────

/** `"pkey-peer/1 code" ‖ 0x00 ‖ <the 6 ASCII password digits>`. */
export function cpacePrsCode(digits: string): Uint8Array {
  if (!/^[0-9]{6}$/.test(digits)) throw new RangeError("cpace: password");
  return cat(utf8("pkey-peer/1 code"), Uint8Array.of(0), utf8(digits));
}

/** `"pkey-peer/1 qr" ‖ 0x00 ‖ <the 16 secret bytes>`. */
export function cpacePrsQr(secret: Uint8Array): Uint8Array {
  if (secret.length !== CPACE_QR_SECRET_BYTES)
    throw new RangeError("cpace: QR secret");
  return cat(utf8("pkey-peer/1 qr"), Uint8Array.of(0), secret);
}

/**
 * The generator: `g = elligator2(SHA-512(generator_string(DSI, PRS, CI, sid, 128))[0..32])`, its
 * u-coordinate as 32 bytes. `ci` is the mode-q prologue and `sid` the window's 10 bytes.
 */
export async function cpaceGenerator(
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
): Promise<Uint8Array> {
  const hash = (
    await sha512(generatorString(utf8(DSI), prs, ci, sid, S_IN_BYTES))
  ).slice(0, 32);
  return elligator2(hash).u;
}

// ── Shares and the refusals (§15.12 step 3) ──────────────────────────────────

export type ShareVerdict =
  | { ok: true }
  | { ok: false; reason: "length" | "non-canonical" | "low-order" };

/**
 * A share is 32 bytes, canonical (bit 255 clear and u < 2^255 − 19) and not one of the low-order
 * points. The canonical check comes first, so the low-order points at or above p refuse as
 * non-canonical. This is stricter than the draft, which processes a non-canonical share.
 */
export function checkShare(y: Uint8Array): ShareVerdict {
  if (y.length !== CPACE_SHARE_LENGTH) return { ok: false, reason: "length" };
  if ((y[31]! & 0x80) !== 0 || decodeU(y) >= P)
    return { ok: false, reason: "non-canonical" };
  if (isX25519LowOrder(y)) return { ok: false, reason: "low-order" };
  return { ok: true };
}

/** A fresh 32-byte scalar. X25519 clamps it. */
export const cpaceScalar = (
  random: (length: number) => Uint8Array = (n) =>
    globalThis.crypto.getRandomValues(new Uint8Array(n)),
): Uint8Array => random(32);

/** `Y = X25519(y, g)`. Null when the backend refuses (a degenerate generator). */
export async function cpaceShare(
  y: Uint8Array,
  g: Uint8Array,
  x25519: X25519Port = webCryptoX25519,
): Promise<Uint8Array | null> {
  const out = await x25519.dh(y, g);
  return out === null || out.length !== 32 || out.every((b) => b === 0)
    ? null
    : out;
}

export interface CpaceFinishInput {
  sid: Uint8Array;
  /** This side's scalar. */
  scalar: Uint8Array;
  /** The joiner's share and the shower's share, as they appear on the wire. */
  ya: Uint8Array;
  yb: Uint8Array;
  /** Which of the two this side is. */
  role: "initiator" | "responder";
  x25519?: X25519Port;
}

/**
 * `ISK = SHA-512(lv_cat("CPace255_ISK", sid, K) ‖ transcript_ir(Ya, "", Yb, ""))`, 64 bytes, or
 * null when K is 32 zero bytes (or the backend refuses the peer's share): the attempt aborts
 * silently. The peer's share must already have passed `checkShare`. The scalar is overwritten.
 */
export async function cpaceIsk(
  i: CpaceFinishInput,
): Promise<Uint8Array | null> {
  const peer = i.role === "initiator" ? i.yb : i.ya;
  const k = await (i.x25519 ?? webCryptoX25519).dh(i.scalar, peer);
  i.scalar.fill(0);
  if (k === null || k.length !== 32 || k.every((b) => b === 0)) return null;
  const empty = new Uint8Array(0);
  const isk = await sha512(
    lvCat(utf8(DSI_ISK), i.sid, k),
    transcriptIr(i.ya, empty, i.yb, empty),
  );
  k.fill(0);
  return isk;
}

/** The Noise PSK of a pairing attempt: `HKDF-SHA256(salt = empty, ikm = ISK, info = "pkey-peer/1 cpace" ‖ 0x00 ‖ slug)`. */
export async function cpacePsk(
  isk: Uint8Array,
  slug: string,
): Promise<Uint8Array> {
  return hkdfSha256(
    new Uint8Array(0),
    isk,
    cat(utf8("pkey-peer/1 cpace"), Uint8Array.of(0), utf8(slug)),
    32,
  );
}

// ── The frames C1 and C2 (§15.12 step 2) ─────────────────────────────────────

/** C1, joiner to shower: `0x01 ‖ kind ‖ Ya`, 34 bytes. */
export const encodeC1 = (kind: CpaceKind, ya: Uint8Array): Uint8Array =>
  cat(Uint8Array.of(CPACE_FRAME_VERSION, CPACE_KIND_BYTE[kind]), ya);

/** C2, shower to joiner: `0x01 ‖ Yb`, 33 bytes. */
export const encodeC2 = (yb: Uint8Array): Uint8Array =>
  cat(Uint8Array.of(CPACE_FRAME_VERSION), yb);

export type FrameVerdict =
  | { ok: true; kind?: CpaceKind; share: Uint8Array }
  | {
      ok: false;
      reason: "length" | "version" | "kind" | "non-canonical" | "low-order";
    };

/** The receiver's judgement of C1: length, version, kind, then the share. */
export function parseC1(b: Uint8Array): FrameVerdict {
  if (b.length !== CPACE_C1_LENGTH) return { ok: false, reason: "length" };
  if (b[0] !== CPACE_FRAME_VERSION) return { ok: false, reason: "version" };
  const kind: CpaceKind | null =
    b[1] === CPACE_KIND_BYTE.code
      ? "code"
      : b[1] === CPACE_KIND_BYTE.qr
        ? "qr"
        : null;
  if (kind === null) return { ok: false, reason: "kind" };
  const share = b.slice(2);
  const v = checkShare(share);
  return v.ok
    ? { ok: true, kind, share }
    : { ok: false, reason: v.reason as "non-canonical" | "low-order" };
}

/** The receiver's judgement of C2: length, version, then the share. */
export function parseC2(b: Uint8Array): FrameVerdict {
  if (b.length !== CPACE_C2_LENGTH) return { ok: false, reason: "length" };
  if (b[0] !== CPACE_FRAME_VERSION) return { ok: false, reason: "version" };
  const share = b.slice(1);
  const v = checkShare(share);
  return v.ok
    ? { ok: true, share }
    : { ok: false, reason: v.reason as "non-canonical" | "low-order" };
}
