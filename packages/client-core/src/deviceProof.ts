// The device proof `pkey-proof/1` (WIRE-CONTRACT-V5 §12.11.1, §15.8; plans/CC-01.md R-6): the
// message a device signs and a verifier for it, both pure. The signing key and its store are
// CC-26's; this module only builds the bytes to sign and checks a signature against them. The
// vectors are `conformance/corpus/v2/device-proof.json`.

import {
  base64UrlDecode,
  ed25519Prechecks,
  isAcceptableEd25519Point,
  isCanonicalB64url,
  isX25519LowOrder,
} from "@polaris-key/jws";
import {
  DEVICE_PROOF_VERSION,
  type DeviceProofPurpose,
} from "@polaris-key/protocol/identity";

/** The `keys` proof's skew window, in seconds either side of now. */
export const DEVICE_PROOF_KEYS_SKEW_SECONDS = 300;

/** The nine purposes, in the order of V5 §12.11.1. */
export const DEVICE_PROOF_PURPOSES: readonly DeviceProofPurpose[] = [
  "keys",
  "nonce",
  "exchange",
  "link",
  "nearby-start",
  "nearby-poll",
  "nearby-approve",
  "vouch",
  "restore",
];

export interface DeviceProofFields {
  purpose: DeviceProofPurpose;
  /** The product slug. */
  product: string;
  /** The `X-PKey-Device` value. */
  deviceId: string;
  /** The purpose's value (line 5). */
  value: string;
  /** Base64url SHA-256 of the presented provider token, or `-` when none (line 6). */
  tokenHash: string;
}

export interface DeviceProof extends DeviceProofFields {
  /** The device's signing key, raw 32 bytes in base64url. */
  signKey: string;
  /** The 64-byte signature, base64url. */
  sig: string;
}

const LINE_FIELD = /^[\x21-\x7e]+$/; // no space, no newline, no control byte
const KEYS_VALUE =
  /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.(0|[1-9][0-9]{0,15})$/;
const P25519 = (1n << 255n) - 19n;

/** The `keys` purpose's value: `<signKey>.<agreeKey>.<issuedAt>`. */
export function deviceProofKeysValue(
  signKey: string,
  agreeKey: string,
  issuedAt: number,
): string {
  return `${signKey}.${agreeKey}.${issuedAt}`;
}

/** The bytes a device signs, or null when a field would break the line format. */
export function deviceProofMessage(f: DeviceProofFields): Uint8Array | null {
  const lines = [
    DEVICE_PROOF_VERSION,
    f.purpose,
    f.product,
    f.deviceId,
    f.value,
    f.tokenHash,
  ];
  if (!lines.every((l) => typeof l === "string" && LINE_FIELD.test(l)))
    return null;
  return new TextEncoder().encode(lines.join("\n"));
}

/** A canonical base64url of exactly 32 bytes, decoded, or null. */
function raw32(s: string): Uint8Array | null {
  if (typeof s !== "string" || s.length !== 43 || !isCanonicalB64url(s))
    return null;
  const b = base64UrlDecode(s);
  return b.length === 32 ? b : null;
}

/** The one X25519 spelling an issuer accepts: bit 255 clear and u < p, and not a low-order point. */
function agreeKeyOk(s: string): boolean {
  const k = raw32(s);
  if (!k || (k[31]! & 0x80) !== 0 || isX25519LowOrder(k)) return false;
  let u = 0n;
  for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(k[i]!);
  return u < P25519;
}

function keysValueOk(p: DeviceProof, now: number | undefined): boolean {
  if (p.tokenHash !== "-" || now === undefined) return false;
  const m = KEYS_VALUE.exec(p.value);
  if (!m || m[1] !== p.signKey || !agreeKeyOk(m[2]!)) return false;
  const issuedAt = Number(m[3]);
  return (
    Number.isSafeInteger(issuedAt) &&
    Math.abs(issuedAt - now) <= DEVICE_PROOF_KEYS_SKEW_SECONDS
  );
}

/** Verifies `sig` by the raw 32-byte `key` over `message`, after the V5 §1.1 prechecks. */
export type Ed25519VerifyPort = (
  key: Uint8Array,
  sig: Uint8Array,
  message: Uint8Array,
) => Promise<boolean>;

/** The default port: WebCrypto Ed25519. */
export const webCryptoEd25519Verify: Ed25519VerifyPort = async (
  key,
  sig,
  message,
) => {
  try {
    const k = await crypto.subtle.importKey(
      "raw",
      key as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      k,
      sig as BufferSource,
      message as BufferSource,
    );
  } catch {
    return false;
  }
};

/**
 * True only for a strict Ed25519 proof by `signKey` (V5 §12.11.1); it never says why not. `now`
 * (epoch seconds) is needed for purpose `keys`, whose `issuedAt` must lie within the skew window.
 */
export async function verifyDeviceProof(
  proof: DeviceProof,
  opts: { now?: number; verify?: Ed25519VerifyPort } = {},
): Promise<boolean> {
  if (!DEVICE_PROOF_PURPOSES.includes(proof.purpose)) return false;
  const key = raw32(proof.signKey);
  if (!key || !isAcceptableEd25519Point(key)) return false;
  const message = deviceProofMessage(proof);
  if (!message) return false;
  if (proof.purpose === "keys" && !keysValueOk(proof, opts.now)) return false;
  if (proof.sig.length !== 86 || !isCanonicalB64url(proof.sig)) return false;
  const sig = base64UrlDecode(proof.sig);
  if (sig.length !== 64 || !ed25519Prechecks(key, sig)) return false;
  return (opts.verify ?? webCryptoEd25519Verify)(key, sig, message);
}
