/// <reference types="@cloudflare/workers-types" />

import { hashKey } from "../../../platform/crypto.js";
import { type Env } from "../../../platform/env.js";
import { randomBytes } from "../../../platform/random.js";
import {
  artefactRef,
  deleteArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";

/** RFC 8628 §6.1's recommended user-code alphabet (20 consonants). */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export const USER_CODE_LENGTH = 8;

/** Retries on an index collision before giving up (a collision among live codes is ~1e-10). */
export const USER_CODE_ATTEMPTS = 5;

/** A fresh user code, normalised (no separator). Rejection sampling keeps it unbiased:
 *  240 is the largest multiple of 20 that fits in a byte. */
export function generateUserCode(): string {
  let out = "";
  while (out.length < USER_CODE_LENGTH) {
    for (const b of randomBytes(USER_CODE_LENGTH * 2)) {
      if (b >= 240) continue;
      out += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
      if (out.length === USER_CODE_LENGTH) break;
    }
  }
  return out;
}

/** `WDJBMJHT` → `WDJB-MJHT`, the display (and `userCode` wire) form. */
export function formatUserCode(normalised: string): string {
  return `${normalised.slice(0, 4)}-${normalised.slice(4)}`;
}

/**
 * What a human typed (or a QR code carried) → the canonical code, or `null` when it cannot be
 * one. Upper-case; spaces and hyphens dropped; anything outside the alphabet, or the wrong
 * length, is invalid — never "corrected", so a lookup only ever happens for a well-formed code.
 */
export function normalizeUserCode(
  raw: string | null | undefined,
): string | null {
  if (!raw || raw.length > 64) return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== USER_CODE_LENGTH) return null;
  for (const ch of code) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/**
 * Single-use store address of the user-code index: normalised user code → the flow's
 * `deviceCode`. Written with `ifAbsent`, so two flows can never claim one live user code.
 *
 * R12-04: a user code is a short-lived bearer handle for the confirmation page, so the address
 * is its peppered hash — a listing yields nothing a visitor could type. The value is the
 * device code, which never leaves the server on this path.
 */
export async function deviceUserKey(
  env: Env,
  product: string,
  normalisedUserCode: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "device-user",
    `${product}:${await hashKey(normalisedUserCode, env.KEY_HASH_PEPPER)}`,
  );
}

/** Drop a flow's user-code index. Records written before the independent code existed carry a
 *  prefix-derived code that does not normalise, and never had an index. */
export async function deleteUserCodeIndex(
  env: Env,
  product: string,
  userCode: string,
): Promise<void> {
  const code = normalizeUserCode(userCode);
  if (code) await deleteArtefact(env, await deviceUserKey(env, product, code));
}
