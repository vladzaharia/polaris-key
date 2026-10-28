// The one `pkey-proof/1` verifier (WIRE-CONTRACT-V5 §12.11.1, §15.8; plans/CC-01.md R-6): an
// Ed25519 signature by a device's signing key over six LF-joined lines. Every purpose goes through
// `verifyDeviceProof`; the `keys` purpose also checks its value and the skew window. The vectors
// are `conformance/corpus/v2/device-proof.json`. Callers: the token exchange (purpose `exchange`)
// and the device-keys route (`keys`, through `verifyKeyPop`).

import type { DeviceProofPurpose } from "@polaris-key/protocol/identity";
import { utf8Encode } from "../../platform/bytes.js";
import {
  isValidAgreeKey,
  isValidSignKey,
  verifyEd25519Strict,
} from "./keys.js";

/** The `keys` proof's skew window, in seconds either side of now. */
export const KEY_POP_SKEW_SECONDS = 300;

const PURPOSES: ReadonlySet<string> = new Set<DeviceProofPurpose>([
  "keys",
  "nonce",
  "exchange",
  "link",
  "nearby-start",
  "nearby-poll",
  "nearby-approve",
  "vouch",
  "restore",
]);
const LINE_FIELD = /^[\x21-\x7e]+$/; // no space, no newline, no control byte
const KEYS_VALUE =
  /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.(0|[1-9][0-9]{0,15})$/;

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
  /** Epoch seconds; required for purpose `keys` (the skew window), unused otherwise. */
  now?: number;
}

/** The bytes the proof signs, or null when a field would break the line format. */
export function deviceProofMessage(
  input: Pick<
    DeviceProofInput,
    "purpose" | "product" | "deviceId" | "value" | "tokenHash"
  >,
): Uint8Array | null {
  const lines = [
    "pkey-proof/1",
    input.purpose,
    input.product,
    input.deviceId,
    input.value,
    input.tokenHash,
  ];
  if (!lines.every((l) => typeof l === "string" && LINE_FIELD.test(l))) {
    return null;
  }
  return utf8Encode(lines.join("\n"));
}

/** The `keys` purpose's value: `<signKey>.<agreeKey>.<issuedAt>` (V5 §15.8). */
export function keyPopValue(
  signKey: string,
  agreeKey: string,
  issuedAt: number,
): string {
  return `${signKey}.${agreeKey}.${issuedAt}`;
}

/** The `keys` purpose's extra rules: the value names this signing key, a valid agreement key and an
 *  `issuedAt` within the skew window of `now`; the token hash is `-`. */
function keysValueOk(input: DeviceProofInput): boolean {
  if (input.tokenHash !== "-" || input.now === undefined) return false;
  const m = KEYS_VALUE.exec(input.value);
  if (!m || m[1] !== input.signKey || !isValidAgreeKey(m[2])) return false;
  const issuedAt = Number(m[3]);
  return (
    Number.isSafeInteger(issuedAt) &&
    Math.abs(issuedAt - input.now) <= KEY_POP_SKEW_SECONDS
  );
}

/** True only for a strict Ed25519 signature by `signKey` over the proof lines; never says why not. */
export async function verifyDeviceProof(
  input: DeviceProofInput,
): Promise<boolean> {
  if (!isValidSignKey(input.signKey)) return false;
  const message = deviceProofMessage(input);
  if (!message || !PURPOSES.has(input.purpose)) return false;
  if (input.purpose === "keys" && !keysValueOk(input)) return false;
  return verifyEd25519Strict(input.signKey, input.sig, message);
}

// ── The `keys` purpose, by its parts ─────────────────────────────────────────────────────────

export interface KeyPopInput {
  product: string;
  deviceId: string;
  signKey: string;
  agreeKey: string;
  issuedAt: number;
  /** The 64-byte Ed25519 signature, base64url. */
  sig: string;
  now: number;
}

/** The bytes a `keys` proof signs, or null when a field would break the line format. */
export function keyPopMessage(
  input: Omit<KeyPopInput, "sig" | "now">,
): Uint8Array | null {
  const { product, deviceId, signKey, agreeKey, issuedAt } = input;
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) return null;
  return deviceProofMessage({
    purpose: "keys",
    product,
    deviceId,
    value: keyPopValue(signKey, agreeKey, issuedAt),
    tokenHash: "-",
  });
}

/** Verify that the holder of `signKey` made this registration (purpose `keys`). */
export function verifyKeyPop(input: KeyPopInput): Promise<boolean> {
  return verifyDeviceProof({
    purpose: "keys",
    product: input.product,
    deviceId: input.deviceId,
    value: keyPopValue(input.signKey, input.agreeKey, input.issuedAt),
    tokenHash: "-",
    signKey: input.signKey,
    sig: input.sig,
    now: input.now,
  });
}
