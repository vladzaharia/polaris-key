// The crypto port of Cloud Sync's end-to-end mode (WIRE-CONTRACT-V5 §13.10) and its key
// hierarchy (§13.10.2). client-core stays pure: a host supplies a `SyncCryptoPort`, and
// `webCryptoSyncPort` is the one on WebCrypto that Node, browsers and workers all have.
//
// Every derivation is HKDF-SHA256 (RFC 5869). Labels are ASCII; a label that scopes by name ends
// in a NUL and then the name. The nonce depends on the key (§13.10.2): K_msg, K_file and the HPKE
// wrap key use a constant nonce (each seals one plaintext); K_chunk, which is per chunk id and not
// per body, uses a synthetic one; K_rec and K_adopt use a random one; K_coll, K_names and K_cid
// seal nothing.

import {
  hmac as hmacSha256,
  webCryptoAead,
  webCryptoX25519,
  type X25519Port,
} from "../peer/noise.js";

export type { X25519Port };

export interface SyncCryptoPort {
  /** SHA-256. */
  sha256(data: Uint8Array): Promise<Uint8Array>;
  /** HKDF-SHA256 (RFC 5869). An empty salt is the hash length of zeros. */
  hkdf(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number,
  ): Promise<Uint8Array>;
  /** HMAC-SHA256. */
  hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
  /** AES-256-GCM with a 128-bit tag; the result is ciphertext followed by the tag. */
  aesGcmSeal(
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
    plaintext: Uint8Array,
  ): Promise<Uint8Array>;
  /** The plaintext, or null when authentication fails. */
  aesGcmOpen(
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array | null>;
  x25519: X25519Port;
  /** Random bytes. */
  random(length: number): Uint8Array;
}

// A copy, so a view into a larger buffer is never handed to WebCrypto whole.
const buf = (b: Uint8Array): ArrayBuffer => Uint8Array.from(b).buffer;

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

export const webCryptoSyncPort: SyncCryptoPort = {
  async sha256(data) {
    return new Uint8Array(await subtle().digest("SHA-256", buf(data)));
  },
  async hkdf(ikm, salt, info, length) {
    const k = await subtle().importKey("raw", buf(ikm), "HKDF", false, [
      "deriveBits",
    ]);
    return new Uint8Array(
      await subtle().deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info) },
        k,
        length * 8,
      ),
    );
  },
  hmac: hmacSha256,
  aesGcmSeal: webCryptoAead.seal,
  aesGcmOpen: webCryptoAead.open,
  x25519: webCryptoX25519,
  random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
};

// ── Labels (§13.10.2) ────────────────────────────────────────────────────────────────────────

/** The HKDF `info` labels, ASCII, without the NUL that scopes some of them. */
export const SYNC_LABELS = {
  kid: "pkey-sync/1 kid",
  coll: "pkey-sync/1 coll",
  names: "pkey-sync/1 names",
  chunkId: "pkey-sync/1 chunk-id",
  value: "pkey-sync/1 value",
  file: "pkey-sync/1 file",
  chunk: "pkey-sync/1 chunk",
  recovery: "pkey-sync/1 recovery",
  adopt: "pkey-sync/1 adopt",
} as const;

export const SYNC_ROOT_BYTES = 32;
export const SYNC_KID_BYTES = 16;
/** The salt of a value key (`K_msg`). */
export const SYNC_VALUE_SALT_BYTES = 16;
/** The salt of a file key (`K_file`). */
export const SYNC_FILE_SALT_BYTES = 32;

const utf8 = new TextEncoder();
const EMPTY = new Uint8Array(0);

/** `label`, then (when `name` is given) a NUL and the UTF-8 name. */
function info(label: string, name?: string): Uint8Array {
  return utf8.encode(name === undefined ? label : `${label}\0${name}`);
}

/** The `kid` of a root: in every envelope header, in the clear. */
export const deriveKid = (p: SyncCryptoPort, root: Uint8Array) =>
  p.hkdf(root, EMPTY, info(SYNC_LABELS.kid), SYNC_KID_BYTES);

/** `K_coll(c)`: `c` is `"$settings"` or the concrete collection name. */
export const deriveCollKey = (
  p: SyncCryptoPort,
  root: Uint8Array,
  collection: string,
) => p.hkdf(root, EMPTY, info(SYNC_LABELS.coll, collection), 32);

/** `K_names`: keys every blinded name. */
export const deriveNamesKey = (p: SyncCryptoPort, root: Uint8Array) =>
  p.hkdf(root, EMPTY, info(SYNC_LABELS.names), 32);

/** `K_cid(c)`: keys the chunk ids of one collection. */
export const deriveChunkIdKey = (
  p: SyncCryptoPort,
  root: Uint8Array,
  collection: string,
) => p.hkdf(root, EMPTY, info(SYNC_LABELS.chunkId, collection), 32);

/** `K_msg`: one key per value, from `K_coll` and a 16-byte salt. */
export const deriveValueKey = (
  p: SyncCryptoPort,
  collKey: Uint8Array,
  salt: Uint8Array,
) => p.hkdf(collKey, salt, info(SYNC_LABELS.value), 32);

/** `K_file`: one key per file version, from `K_coll` and a 32-byte salt. */
export const deriveFileKey = (
  p: SyncCryptoPort,
  collKey: Uint8Array,
  salt: Uint8Array,
) => p.hkdf(collKey, salt, info(SYNC_LABELS.file), 32);

/** `K_chunk`: one key per chunk id (its 32 raw bytes are the salt). */
export const deriveChunkKey = (
  p: SyncCryptoPort,
  collKey: Uint8Array,
  chunkId: Uint8Array,
) => p.hkdf(collKey, chunkId, info(SYNC_LABELS.chunk), 32);

/** `K_rec`: the 16-byte recovery code is the key material and the `ringId` text is the salt. */
export const deriveRecoveryKey = (
  p: SyncCryptoPort,
  code: Uint8Array,
  ringId: string,
) => p.hkdf(code, utf8.encode(ringId), info(SYNC_LABELS.recovery), 32);

/** `K_adopt`: wraps a foreign root after an account merge. */
export const deriveAdoptKey = (p: SyncCryptoPort, root: Uint8Array) =>
  p.hkdf(root, EMPTY, info(SYNC_LABELS.adopt), 32);
