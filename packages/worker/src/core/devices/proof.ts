// The `pkey-proof/1` proof for the purposes that carry no `issuedAt` (WIRE-CONTRACT-V5 §12.11.1):
// an Ed25519 signature by a device's signing key over six LF-joined lines. The `keys` purpose has
// its own timestamped check in `keys.ts` (`verifyKeyPop`). The first caller is the token exchange
// (I-13.4, purpose `exchange`).

import type { DeviceProofPurpose } from "@polaris-key/protocol/identity";
import { utf8Encode } from "../../platform/bytes.js";
import { isValidSignKey, verifyEd25519Strict } from "./keys.js";

const LINE_FIELD = /^[\x21-\x7e]+$/; // no space, no newline, no control byte

export interface DeviceProofInput {
  purpose: DeviceProofPurpose;
  product: string;
  deviceId: string;
  /** The purpose's value (line 5). */
  value: string;
  /** Base64url SHA-256 of the presented provider token, or `-` when none (line 6). */
  tokenHash: string;
  /** The device's signing key, raw 32 bytes in base64url. */
  signKey: string;
  /** The 64-byte signature, base64url. */
  sig: string;
}

/** The bytes the proof signs, or null when a field would break the line format. */
export function deviceProofMessage(
  input: Omit<DeviceProofInput, "signKey" | "sig">,
): Uint8Array | null {
  const lines = [
    "pkey-proof/1",
    input.purpose,
    input.product,
    input.deviceId,
    input.value,
    input.tokenHash,
  ];
  if (!lines.every((l) => LINE_FIELD.test(l))) return null;
  return utf8Encode(lines.join("\n"));
}

/** True only for a strict Ed25519 signature by `signKey` over the proof lines; never says why not. */
export async function verifyDeviceProof(
  input: DeviceProofInput,
): Promise<boolean> {
  if (!isValidSignKey(input.signKey)) return false;
  const message = deviceProofMessage(input);
  if (!message) return false;
  return verifyEd25519Strict(input.signKey, input.sig, message);
}
