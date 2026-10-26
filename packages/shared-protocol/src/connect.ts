// @polaris-key/protocol/connect — Cloud Connect on the wire: the device certificate
// (`pkey-peer+jws`) and the roster (`pkey-ring+jws`). Types and constants only, no runtime, no
// crypto. WIRE-CONTRACT-V5 §15 is the normative text; each export names its subsection.
// Both documents are signed by the product key and verified against the effective product set;
// a release key or a content key never signs either (§15.1).

/** §15.2: the `typ` of a device certificate. */
export const PEER_CERT_TYP = "pkey-peer+jws";
/** §15.3: the `typ` of a roster. */
export const RING_TYP = "pkey-ring+jws";

/** §15.1: `expiresAt = issuedAt + PEER_CERT_SECONDS` for every certificate the Worker signs. */
export const PEER_CERT_SECONDS = 604_800;
/** §15.2 step 5: a verifier refuses `expiresAt − issuedAt` above this. */
export const MAX_PEER_CERT_SECONDS = 604_800;
/** §15.2: a certificate is renewed when less than this is left, or when the ring epoch moves. */
export const PEER_CERT_RENEW_SECONDS = 302_400;
/** §15.3: `expiresAt = issuedAt + RING_SECONDS` for every roster the Worker signs. */
export const RING_SECONDS = 604_800;
/** §15.3: a roster holds 1 to this many devices. */
export const MAX_RING_DEVICES = 128;
/** §15.6: the largest peer message. */
export const MAX_PEER_MESSAGE_BYTES = 1_048_576;
/** §15.1, §2: the clock skew a certificate or roster check allows, in seconds. */
export const PEER_CLOCK_SKEW_SECONDS = 300;

/** §15.2 step 3: a device id, whole-string, ASCII (§3.3 rule 1). */
export const PEER_DEVICE_ID_PATTERN = "^[A-Za-z0-9_-]{32}$";
/** §15.2 step 4: a raw 32-byte public key as canonical base64url (43 characters, no padding). */
export const PEER_KEY_PATTERN = "^[A-Za-z0-9_-]{43}$";

/** §15.2, §15.3: one device's public keys, as the roster lists them. */
export interface PeerDeviceKeys {
  deviceId: string;
  /** Raw Ed25519 public key, canonical base64url. */
  signKey: string;
  /** Raw X25519 public key, canonical base64url. */
  agreeKey: string;
}

/**
 * A `pkey-peer+jws` payload (§15.2). `sub` is the pairwise subject, never the account id.
 * Integer claims (`ringEpoch` at least 1, the timestamps at least 0) are decided from their token
 * (§3.1); members beyond these are ignored (§3.2). There is no anti-replay floor.
 */
export interface PeerCertDoc extends PeerDeviceKeys {
  iss: string;
  aud: string;
  sub: string;
  /** The ring epoch at issue, an integer of at least 1. */
  ringEpoch: number;
  issuedAt: number;
  expiresAt: number;
}

/**
 * A `pkey-ring+jws` payload (§15.3). Device-less. `devices` is sorted by `deviceId` bytes, with
 * unique ids and unique keys.
 */
export interface RingDoc {
  iss: string;
  aud: string;
  sub: string;
  /** An integer of at least 1. */
  epoch: number;
  issuedAt: number;
  expiresAt: number;
  devices: PeerDeviceKeys[];
}
