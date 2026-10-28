// The recovery code and the adopt blob (WIRE-CONTRACT-V5 §13.11.4).
//
//   code    = 16 random bytes ‖ the first 4 bytes of SHA-256(those 16): 160 bits, 32 Crockford
//             base32 characters, shown as 8 groups of 4 joined by hyphens.
//   blob    = 0x01 ‖ n12 ‖ AES-256-GCM(K, n, aad, R)       (recovery and adopt share the layout)
//   recovery: K = K_rec, aad = "pkey-sync/1 recovery" ‖ ringId ‖ u32be(epoch) ‖ kid
//   adopt:    K = K_adopt (of the new root), aad = "pkey-sync/1 adopt" ‖ fromRingId ‖ u32be(epoch)
//             ‖ kid, sealing the foreign or previous root; `epoch` and `kid` are that root's.

import {
  SYNC_LABELS,
  SYNC_ROOT_BYTES,
  deriveAdoptKey,
  deriveRecoveryKey,
  type SyncCryptoPort,
} from "./crypto.js";
import { u32be } from "./hpke.js";

export const RECOVERY_CODE_BYTES = 16;
export const RECOVERY_CHECKSUM_BYTES = 4;
export const RECOVERY_CODE_CHARS = 32;
export const RECOVERY_BLOB_VERSION = 0x01;
/** The client error code for a bad checksum or a failed unwrap. */
export const RECOVERY_CODE_INVALID = "recovery-code-invalid";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const utf8 = new TextEncoder();

/** The code's 20 bytes: the secret and its checksum. */
async function codeBytes(
  p: SyncCryptoPort,
  code: Uint8Array,
): Promise<Uint8Array> {
  const out = new Uint8Array(RECOVERY_CODE_BYTES + RECOVERY_CHECKSUM_BYTES);
  out.set(code, 0);
  out.set(
    (await p.sha256(code)).subarray(0, RECOVERY_CHECKSUM_BYTES),
    RECOVERY_CODE_BYTES,
  );
  return out;
}

/** A fresh 16-byte code from the port's random source, or the given one. */
export const newRecoveryCode = (p: SyncCryptoPort): Uint8Array =>
  p.random(RECOVERY_CODE_BYTES);

/** The text shown to the person: 8 groups of 4, upper case, joined by hyphens. */
export async function encodeRecoveryCode(
  p: SyncCryptoPort,
  code: Uint8Array,
): Promise<string> {
  if (code.length !== RECOVERY_CODE_BYTES) {
    throw new Error("recovery code must be 16 bytes");
  }
  const bytes = await codeBytes(p, code);
  let chars = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      chars += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return chars.match(/.{4}/g)!.join("-");
}

/**
 * The 16-byte code in a typed or pasted string, or null. It ignores case, spaces and hyphens, maps
 * `I` and `L` to `1` and `O` to `0`, and checks the length and the checksum.
 */
export async function parseRecoveryCode(
  p: SyncCryptoPort,
  text: string,
): Promise<Uint8Array | null> {
  const clean = text
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (clean.length !== RECOVERY_CODE_CHARS) return null;
  const bytes = new Uint8Array(RECOVERY_CODE_BYTES + RECOVERY_CHECKSUM_BYTES);
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes[at++] = (acc >>> (bits - 8)) & 0xff;
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  const code = bytes.slice(0, RECOVERY_CODE_BYTES);
  const want = await codeBytes(p, code);
  let diff = 0;
  for (let i = RECOVERY_CODE_BYTES; i < bytes.length; i++) {
    diff |= bytes[i]! ^ want[i]!;
  }
  return diff === 0 ? code : null;
}

const aadOf = (
  label: string,
  ringId: string,
  epoch: number,
  kid: Uint8Array,
): Uint8Array => {
  const head = utf8.encode(`${label}${ringId}`);
  const out = new Uint8Array(head.length + 4 + kid.length);
  out.set(head, 0);
  out.set(u32be(epoch), head.length);
  out.set(kid, head.length + 4);
  return out;
};

async function sealBlob(
  p: SyncCryptoPort,
  key: Uint8Array,
  aad: Uint8Array,
  root: Uint8Array,
  nonce?: Uint8Array,
): Promise<Uint8Array> {
  const n = nonce ?? p.random(12);
  const ct = await p.aesGcmSeal(key, n, aad, root);
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = RECOVERY_BLOB_VERSION;
  out.set(n, 1);
  out.set(ct, 13);
  return out;
}

async function openBlob(
  p: SyncCryptoPort,
  key: Uint8Array,
  aad: Uint8Array,
  blob: Uint8Array,
): Promise<Uint8Array | null> {
  const min = 1 + 12 + SYNC_ROOT_BYTES + 16;
  if (blob.length !== min || blob[0] !== RECOVERY_BLOB_VERSION) return null;
  const root = await p.aesGcmOpen(
    key,
    blob.subarray(1, 13),
    aad,
    blob.subarray(13),
  );
  return root !== null && root.length === SYNC_ROOT_BYTES ? root : null;
}

/** `recovery.ct`: the root sealed under the code. `nonce` is for a test vector only. */
export async function wrapRecovery(
  p: SyncCryptoPort,
  code: Uint8Array,
  ringId: string,
  epoch: number,
  kid: Uint8Array,
  root: Uint8Array,
  nonce?: Uint8Array,
): Promise<Uint8Array> {
  return sealBlob(
    p,
    await deriveRecoveryKey(p, code, ringId),
    aadOf(SYNC_LABELS.recovery, ringId, epoch, kid),
    root,
    nonce,
  );
}

/** The root, or null (a wrong code, ring, epoch or `kid`, or tampering). */
export async function unwrapRecovery(
  p: SyncCryptoPort,
  code: Uint8Array,
  ringId: string,
  epoch: number,
  kid: Uint8Array,
  blob: Uint8Array,
): Promise<Uint8Array | null> {
  return openBlob(
    p,
    await deriveRecoveryKey(p, code, ringId),
    aadOf(SYNC_LABELS.recovery, ringId, epoch, kid),
    blob,
  );
}

/** The ring (`fromRingId`, `epoch`) and root `kid` that an adopt blob names. */
export interface AdoptFrom {
  fromRingId: string;
  epoch: number;
  kid: Uint8Array;
}

/** Seal a foreign or previous root `oldRoot` under `K_adopt` of the current root. */
export async function sealAdopt(
  p: SyncCryptoPort,
  currentRoot: Uint8Array,
  from: AdoptFrom,
  oldRoot: Uint8Array,
  nonce?: Uint8Array,
): Promise<Uint8Array> {
  return sealBlob(
    p,
    await deriveAdoptKey(p, currentRoot),
    aadOf(SYNC_LABELS.adopt, from.fromRingId, from.epoch, from.kid),
    oldRoot,
    nonce,
  );
}

/** The adopted root, or null. */
export async function openAdopt(
  p: SyncCryptoPort,
  currentRoot: Uint8Array,
  from: AdoptFrom,
  blob: Uint8Array,
): Promise<Uint8Array | null> {
  return openBlob(
    p,
    await deriveAdoptKey(p, currentRoot),
    aadOf(SYNC_LABELS.adopt, from.fromRingId, from.epoch, from.kid),
    blob,
  );
}
