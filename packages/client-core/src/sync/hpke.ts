// `pkey-sync-wrap/1` (WIRE-CONTRACT-V5 §13.11.1): RFC 9180 HPKE `mode_base`, single shot, with
// KEM 0x0020 (DHKEM X25519, HKDF-SHA256), KDF 0x0001 (HKDF-SHA256) and AEAD 0x0002 (AES-256-GCM).
// A wrap carries one root `R` to a device's agreement key. Sequence 0 is the only message, so the
// AEAD nonce is the key schedule's `base_nonce`.

import { SYNC_ROOT_BYTES, type SyncCryptoPort } from "./crypto.js";

/** The `kem` member of a wrap: the HPKE KEM id as a JSON integer (0x0010 would be P-256). */
export const HPKE_KEM_X25519 = 0x0020;
export const HPKE_KDF_SHA256 = 0x0001;
export const HPKE_AEAD_AES256GCM = 0x0002;
export const HPKE_ENC_BYTES = 32;
/** A wrapped root: 32 bytes of `R` and the 16-byte tag. */
export const WRAP_CT_BYTES = SYNC_ROOT_BYTES + 16;

const utf8 = new TextEncoder();
const EMPTY = new Uint8Array(0);
const NK = 32;
const NN = 12;

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, q) => n + q.length, 0));
  parts.reduce((at, q) => {
    out.set(q, at);
    return at + q.length;
  }, 0);
  return out;
};

const i2osp2 = (n: number): Uint8Array => Uint8Array.of(n >>> 8, n & 0xff);
export const u32be = (n: number): Uint8Array =>
  Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);

const KEM_SUITE = cat(utf8.encode("KEM"), i2osp2(HPKE_KEM_X25519));
const HPKE_SUITE = cat(
  utf8.encode("HPKE"),
  i2osp2(HPKE_KEM_X25519),
  i2osp2(HPKE_KDF_SHA256),
  i2osp2(HPKE_AEAD_AES256GCM),
);
const V1 = utf8.encode("HPKE-v1");

/** HKDF-Extract (RFC 5869): HMAC with the salt as the key. */
async function extract(
  p: SyncCryptoPort,
  salt: Uint8Array,
  ikm: Uint8Array,
): Promise<Uint8Array> {
  return p.hmac(salt.length === 0 ? new Uint8Array(32) : salt, ikm);
}

/** HKDF-Expand (RFC 5869) for any length up to 255 blocks. */
async function expand(
  p: SyncCryptoPort,
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(Math.ceil(length / 32) * 32);
  let t: Uint8Array = EMPTY;
  for (let i = 1; i * 32 <= out.length; i++) {
    t = await p.hmac(prk, cat(t, info, Uint8Array.of(i)));
    out.set(t, (i - 1) * 32);
  }
  return out.slice(0, length);
}

const labeledExtract = (
  p: SyncCryptoPort,
  suite: Uint8Array,
  salt: Uint8Array,
  label: string,
  ikm: Uint8Array,
) => extract(p, salt, cat(V1, suite, utf8.encode(label), ikm));

const labeledExpand = (
  p: SyncCryptoPort,
  suite: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
) =>
  expand(
    p,
    prk,
    cat(i2osp2(length), V1, suite, utf8.encode(label), info),
    length,
  );

async function sharedSecret(
  p: SyncCryptoPort,
  dh: Uint8Array,
  kemContext: Uint8Array,
): Promise<Uint8Array> {
  const prk = await labeledExtract(p, KEM_SUITE, EMPTY, "eae_prk", dh);
  return labeledExpand(p, KEM_SUITE, prk, "shared_secret", kemContext, 32);
}

/** The AEAD key and nonce of a `mode_base` context (RFC 9180 §5.1). */
export async function hpkeKeySchedule(
  p: SyncCryptoPort,
  secret: Uint8Array,
  info: Uint8Array,
): Promise<{ key: Uint8Array; nonce: Uint8Array }> {
  const pskIdHash = await labeledExtract(
    p,
    HPKE_SUITE,
    EMPTY,
    "psk_id_hash",
    EMPTY,
  );
  const infoHash = await labeledExtract(
    p,
    HPKE_SUITE,
    EMPTY,
    "info_hash",
    info,
  );
  const context = cat(Uint8Array.of(0x00), pskIdHash, infoHash);
  const s = await labeledExtract(p, HPKE_SUITE, secret, "secret", EMPTY);
  return {
    key: await labeledExpand(p, HPKE_SUITE, s, "key", context, NK),
    nonce: await labeledExpand(p, HPKE_SUITE, s, "base_nonce", context, NN),
  };
}

export interface HpkeSealed {
  /** The sender's ephemeral public key. */
  enc: Uint8Array;
  ct: Uint8Array;
}

/** `Encap` (RFC 9180 §4.1): the encapsulated key and the KEM's shared secret. */
export async function hpkeEncap(
  p: SyncCryptoPort,
  recipientPublicKey: Uint8Array,
  ephemeralKey?: Uint8Array,
): Promise<{ enc: Uint8Array; sharedSecret: Uint8Array }> {
  const skE = ephemeralKey ?? p.random(32);
  const enc = await p.x25519.publicKey(skE);
  const dh = await p.x25519.dh(skE, recipientPublicKey);
  if (dh === null || dh.every((b) => b === 0)) {
    throw new Error("hpke: the recipient key is not usable");
  }
  return {
    enc,
    sharedSecret: await sharedSecret(p, dh, cat(enc, recipientPublicKey)),
  };
}

/**
 * `SealBase` for one message. `ephemeralKey` is the 32-byte private scalar of the encapsulation;
 * leave it out (always, outside a test vector) to draw a fresh one from the port.
 */
export async function hpkeSeal(
  p: SyncCryptoPort,
  recipientPublicKey: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  ephemeralKey?: Uint8Array,
): Promise<HpkeSealed> {
  const { enc, sharedSecret: ss } = await hpkeEncap(
    p,
    recipientPublicKey,
    ephemeralKey,
  );
  const { key, nonce } = await hpkeKeySchedule(p, ss, info);
  return { enc, ct: await p.aesGcmSeal(key, nonce, aad, plaintext) };
}

/** `OpenBase`: the plaintext, or null for a bad `enc`, a wrong key, info or aad, or tampering. */
export async function hpkeOpen(
  p: SyncCryptoPort,
  recipientPrivateKey: Uint8Array,
  enc: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array | null> {
  if (enc.length !== HPKE_ENC_BYTES) return null;
  const dh = await p.x25519.dh(recipientPrivateKey, enc);
  if (dh === null || dh.every((b) => b === 0)) return null;
  const pkR = await p.x25519.publicKey(recipientPrivateKey);
  const ss = await sharedSecret(p, dh, cat(enc, pkR));
  const { key, nonce } = await hpkeKeySchedule(p, ss, info);
  return p.aesGcmOpen(key, nonce, aad, ciphertext);
}

// ── The wrap (§13.11.1) ──────────────────────────────────────────────────────────────────────

export interface WrapContext {
  product: string;
  deviceId: string;
  ringId: string;
  /** At least 1. */
  epoch: number;
}

/** `"pkey-sync/1 wrap\0" ‖ product ‖ 0x00 ‖ deviceId ‖ 0x00 ‖ ringId ‖ 0x00 ‖ u32be(epoch)`. */
export function wrapInfo(c: WrapContext): Uint8Array {
  return cat(
    utf8.encode("pkey-sync/1 wrap\0"),
    utf8.encode(c.product),
    Uint8Array.of(0),
    utf8.encode(c.deviceId),
    Uint8Array.of(0),
    utf8.encode(c.ringId),
    Uint8Array.of(0),
    u32be(c.epoch),
  );
}

/** A `pkey-sync-wrap/1` as the routes carry it, in bytes. */
export interface SyncWrap {
  kem: number;
  enc: Uint8Array;
  ct: Uint8Array;
}

/** Wrap `root` to a device's agreement key. `kid` (16 bytes, of `root`) is the associated data. */
export async function wrapRoot(
  p: SyncCryptoPort,
  recipientPublicKey: Uint8Array,
  c: WrapContext,
  kid: Uint8Array,
  root: Uint8Array,
  ephemeralKey?: Uint8Array,
): Promise<SyncWrap> {
  const { enc, ct } = await hpkeSeal(
    p,
    recipientPublicKey,
    wrapInfo(c),
    kid,
    root,
    ephemeralKey,
  );
  return { kem: HPKE_KEM_X25519, enc, ct };
}

/**
 * The root in a wrap, or null: an unknown `kem`, a wrong key, context or `kid`, tampering, or a
 * plaintext that is not 32 bytes. The caller still checks that `kid(R)` equals the ring's `rootKid`.
 */
export async function unwrapRoot(
  p: SyncCryptoPort,
  recipientPrivateKey: Uint8Array,
  c: WrapContext,
  kid: Uint8Array,
  wrap: SyncWrap,
): Promise<Uint8Array | null> {
  if (wrap.kem !== HPKE_KEM_X25519) return null;
  const root = await hpkeOpen(
    p,
    recipientPrivateKey,
    wrap.enc,
    wrapInfo(c),
    kid,
    wrap.ct,
  );
  return root !== null && root.length === SYNC_ROOT_BYTES ? root : null;
}
