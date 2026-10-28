// The device key port and the `pkey-proof/1` signer (CC-26.1; plans/CC-01.md R-5, R-6). Pure: the
// host supplies a `DeviceKeyPort` (a key store per SDK, CC-26.2 and later; the browser's is in
// `deviceKeyStoreWeb.ts`) and this module builds the bytes to sign, signs them through the port
// and checks the result against the CC-03.4 verifier before returning it. The private halves of
// both keys stay inside the port: nothing here asks for them, and nothing here can.

import { base64UrlEncodeBytes } from "@polaris-key/jws";
import type { DeviceProofPurpose } from "@polaris-key/protocol/identity";
import {
  deviceProofKeysValue,
  deviceProofMessage,
  verifyDeviceProof,
  type DeviceProof,
  type Ed25519VerifyPort,
} from "./deviceProof.js";

/** A device's two public keys: raw 32 bytes, canonical base64url (43 characters). */
export interface DevicePublicKeys {
  /** The Ed25519 signing key. */
  signKey: string;
  /** The X25519 agreement key. */
  agreeKey: string;
  /**
   * The local generation: 1 for the first key pair, plus one on every `rotate()`. It is the
   * store's own count, not the server's `keySeq` (the answer to `PUT /devices/keys`).
   */
  generation: number;
}

/**
 * Custody of one device's signing (Ed25519) and agreement (X25519) keys. Keys are made on first
 * need and never leave the port: callers get public halves, signatures and shared secrets.
 */
export interface DeviceKeyPort {
  /** The public keys, making the key pair first if the store holds none. */
  ensure(): Promise<DevicePublicKeys>;
  /** The public keys, or null when the store holds none. Never makes keys. */
  publicKeys(): Promise<DevicePublicKeys | null>;
  /** The 64-byte Ed25519 signature by the signing key over `message`. */
  sign(message: Uint8Array): Promise<Uint8Array>;
  /** X25519 with the agreement key and a peer's raw public key; null when the peer key is refused. */
  dh(peerPublic: Uint8Array): Promise<Uint8Array | null>;
  /** Replaces both keys with a new pair and returns it (`generation` + 1). */
  rotate(): Promise<DevicePublicKeys>;
  /**
   * Where the keys live: "durable" survives a reload, "memory" dies with the page. Optional; a
   * port without it is taken to be durable. A memory port must not register keys (every reload
   * would be a key change, and the server allows 4 a day).
   */
  persistence?(): "durable" | "memory" | Promise<"durable" | "memory">;
  /** Deletes both keys. The next `ensure()` makes a new pair, with `generation` starting again. */
  wipe(): Promise<void>;
}

/** The store cannot hold or use the keys here (no Ed25519 or X25519, no storage it may use). */
export class DeviceKeyUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceKeyUnsupportedError";
  }
}

/**
 * The stored key record exists but cannot be used (wrong shape, extractable keys, or a record
 * that does not parse or match). It is never replaced automatically: replacing it would silently
 * change the device's identity. Only `wipe()` clears it; `ensure()` then makes a new pair.
 */
export class DeviceKeysUnreadableError extends Error {
  constructor(message = "device keys: the record is unreadable") {
    super(message);
    this.name = "DeviceKeysUnreadableError";
  }
}

/** A proof could not be built or did not verify. The text never names a key or a signature. */
export class DeviceProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceProofError";
  }
}

export interface SignDeviceProofOptions {
  purpose: DeviceProofPurpose;
  /** The product slug. */
  product: string;
  /** The `X-PKey-Device` value. */
  deviceId: string;
  /** The purpose's value (line 5). For `keys`, use `signKeysProof`. */
  value: string;
  /** Base64url SHA-256 of the presented provider token; default `-` (none). */
  tokenHash?: string;
  /** Epoch seconds for the `keys` skew check; default the clock. */
  now?: number;
}

/** @internal Test seam: the verifier the signer checks its own result with. */
export interface SignDeviceProofInternal extends SignDeviceProofOptions {
  verify?: Ed25519VerifyPort;
}

const PRODUCT_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

async function refuseMemoryOnly(
  port: DeviceKeyPort,
  allowEphemeral: boolean | undefined,
): Promise<void> {
  if (allowEphemeral) return;
  if ((await port.persistence?.()) === "memory")
    throw new DeviceKeyUnsupportedError("memory-only");
}

/**
 * Builds the `pkey-proof/1` message for `purpose`, signs it through the port and returns the
 * proof. Throws `DeviceProofError` when a field breaks the line format, when the keys changed
 * while signing, or when the result would not verify.
 */
export function signDeviceProof(
  port: DeviceKeyPort,
  o: SignDeviceProofOptions,
): Promise<DeviceProof> {
  return signDeviceProofInternal(port, o);
}

/** @internal Same as `signDeviceProof`, with the test seam. Not exported from the package. */
export async function signDeviceProofInternal(
  port: DeviceKeyPort,
  o: SignDeviceProofInternal,
): Promise<DeviceProof> {
  if (o.purpose === "keys")
    throw new DeviceProofError("device proof: use signKeysProof for keys");
  return signAny(port, o);
}

async function signAny(
  port: DeviceKeyPort,
  o: SignDeviceProofInternal,
): Promise<DeviceProof> {
  const before = await port.ensure();
  const fields = {
    purpose: o.purpose,
    product: o.product,
    deviceId: o.deviceId,
    value: o.value,
    tokenHash: o.tokenHash ?? "-",
  };
  const message = deviceProofMessage(fields);
  if (!message) throw new DeviceProofError("device proof: bad field");
  const sig = base64UrlEncodeBytes(await port.sign(message));
  const after = await port.publicKeys();
  if (
    !after ||
    after.signKey !== before.signKey ||
    after.generation !== before.generation
  )
    throw new DeviceProofError("device proof: keys changed while signing");
  const proof: DeviceProof = { ...fields, signKey: before.signKey, sig };
  const ok = await verifyDeviceProof(proof, {
    now: o.now ?? Math.floor(Date.now() / 1000),
    verify: o.verify,
  });
  if (!ok) throw new DeviceProofError("device proof: did not verify");
  return proof;
}

/** The `keys` proof: the value names the port's own `signKey` and `agreeKey` and `issuedAt`. */
export async function signKeysProof(
  port: DeviceKeyPort,
  o: {
    product: string;
    deviceId: string;
    /** Epoch seconds; default the clock. */
    issuedAt?: number;
    /** Sign although the keys die with the page (a flow that registers nothing). */
    allowEphemeral?: boolean;
    /** @internal Test seam. */
    verify?: Ed25519VerifyPort;
  },
): Promise<{ proof: DeviceProof; keys: DevicePublicKeys; issuedAt: number }> {
  if (!PRODUCT_SLUG.test(o.product))
    throw new DeviceProofError("device proof: bad product");
  await refuseMemoryOnly(port, o.allowEphemeral);
  const issuedAt = o.issuedAt ?? Math.floor(Date.now() / 1000);
  const keys = await port.ensure();
  const proof = await signAny(port, {
    purpose: "keys",
    product: o.product,
    deviceId: o.deviceId,
    value: deviceProofKeysValue(keys.signKey, keys.agreeKey, issuedAt),
    now: issuedAt,
    verify: o.verify,
  });
  if (proof.signKey !== keys.signKey)
    throw new DeviceProofError("device proof: keys changed while signing");
  return { proof, keys, issuedAt };
}

/** The body of `PUT /<p>/devices/keys` (CC-03.2): `sig` is the `keys` proof. */
export interface DeviceKeysRequest {
  signKey: string;
  agreeKey: string;
  issuedAt: number;
  sig: string;
}

/** The answer of `PUT /<p>/devices/keys`. */
export interface DeviceKeysResponse {
  keySeq: number;
}

/**
 * The key-registration helper: the request for `PUT <base>/<product>/devices/keys` for the
 * port's keys. The caller sends it with the device bearer and `X-PKey-Device`; resending it is
 * safe (the server answers a registered pair with its `keySeq` and spends no budget).
 */
export async function buildDeviceKeysRequest(
  port: DeviceKeyPort,
  o: {
    product: string;
    deviceId: string;
    issuedAt?: number;
    allowEphemeral?: boolean;
    /** @internal Test seam. */
    verify?: Ed25519VerifyPort;
  },
): Promise<{ path: string; body: DeviceKeysRequest }> {
  const { proof, keys, issuedAt } = await signKeysProof(port, o);
  return {
    path: `/${o.product}/devices/keys`,
    body: {
      signKey: keys.signKey,
      agreeKey: keys.agreeKey,
      issuedAt,
      sig: proof.sig,
    },
  };
}
